using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace Hegeng
{
    public sealed class FarmResult { public bool Ok; public string Message; public FarmResult(bool ok, string message) { Ok=ok; Message=message; } }
    public sealed class FarmCareStatus { public bool Allowed; public string Reason; public int Remaining; public long? NextAt; }
    public sealed class FarmUnit { public string Id,Name,Art,Kind,Status; public int Days,Total,Moisture; public double Weight; }
    public sealed class FarmProduct { public string Id,Name,Art,Kind; public int Days,Cost; public double ValueMin,ValueMax; public bool Recommended; public string[] Seasons; }
    public sealed class FarmGood { public string Id,Name,Description,Art,Category; public int Cost,Limit; }
    public sealed class FarmReceipt { public string Id,Summary,Day; public int Subtotal,Discount,Total,Count; }
    public sealed class FarmQuote { public int Subtotal,Discount,Total,Count; public bool Valid; public string Reason; }
    public sealed class FarmModel
    {
        // All values and prices are offline proposals. Nothing is written to disk or sent externally.
        public int Points=80,Feed=6,XP=120,Eggs,Crops,Meat,Fertilizer=2,Tools=1,Seeds,Decorations,EggsAvailable=3,SignStreak;
        public bool CouponAvailable { get { return coupons>0; } }
        public int CouponCount { get { return coupons; } }
        public bool WelcomeClaimed { get; private set; }
        public int AdToday { get; private set; }
        public int DeviceGeneration { get; private set; }
        public string DeviceStatus="idle",DeviceUnitId="";
        public List<FarmUnit> Plots=new List<FarmUnit>(), Animals=new List<FarmUnit>();
        public List<FarmProduct> Products=new List<FarmProduct>(); public List<FarmGood> Goods=new List<FarmGood>();
        public Dictionary<string,int> Cart=new Dictionary<string,int>(); public List<FarmReceipt> Receipts=new List<FarmReceipt>();
        const long Hour=3600000L,DayMs=86400000L,ChinaOffset=8*Hour;
        int coupons=1,animalSerial;
        string day;
        readonly Dictionary<string,int> bought=new Dictionary<string,int>();
        readonly Dictionary<string,int> progress=new Dictionary<string,int>();
        readonly HashSet<string> taskClaims=new HashSet<string>();
        readonly HashSet<string> signedDays=new HashSet<string>();
        readonly HashSet<string> adReceipts=new HashSet<string>();
        readonly Dictionary<string,FarmReceipt> purchases=new Dictionary<string,FarmReceipt>();
        sealed class Care { public string Day; public int Used; public long? LastAt; }
        readonly Dictionary<string,Care> care=new Dictionary<string,Care>();
        static readonly Regex KeyPattern=new Regex("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",RegexOptions.CultureInvariant);
        static readonly string[] SignLabels={"20积分","30积分","1份饲料","40积分","1份肥料","60积分","满60减20积分券"};
        static readonly string[] TaskIds={"browse","care","harvest"};
        static FarmResult Yes(string message) { return new FarmResult(true,message); }
        static FarmResult No(string message) { return new FarmResult(false,message); }
        static long Now(long value) { return value==-1?DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():value; }
        static bool CanAdd(int value,int amount) { return value>=0&&amount>=0&&(long)value+amount<=int.MaxValue; }
        static string ChinaDay(long now)
        {
            if(now<0)throw new ArgumentOutOfRangeException("now");
            return DateTimeOffset.FromUnixTimeMilliseconds(now).UtcDateTime.AddHours(8).ToString("yyyy-MM-dd",CultureInfo.InvariantCulture);
        }
        bool Sync(long now)
        {
            string next;try{next=ChinaDay(now);}catch(ArgumentException){return false;}
            if(day!=null&&string.CompareOrdinal(next,day)<0)return false;
            if(day!=next)
            {
                day=next;bought.Clear();progress.Clear();taskClaims.Clear();AdToday=0;
            }
            SignStreak=CurrentStreak(day);
            return true;
        }
        int CurrentStreak(string currentDay)
        {
            DateTime cursor=DateTime.ParseExact(currentDay,"yyyy-MM-dd",CultureInfo.InvariantCulture);
            if(!signedDays.Contains(currentDay))cursor=cursor.AddDays(-1);
            int streak=0;
            while(signedDays.Contains(cursor.ToString("yyyy-MM-dd",CultureInfo.InvariantCulture)))
            { streak++;if(cursor==DateTime.MinValue)break;cursor=cursor.AddDays(-1); }
            return streak;
        }
        bool AssetsValid()
        { return Points>=0&&Feed>=0&&XP>=0&&Eggs>=0&&Crops>=0&&Meat>=0&&Fertilizer>=0&&Tools>=0&&Seeds>=0&&Decorations>=0&&coupons>=0; }
        FarmUnit Unit(string id) { return Plots.Find(x=>x.Id==id)??Animals.Find(x=>x.Id==id); }
        Care CareFor(string id)
        {
            Care value;
            if(!care.TryGetValue(id,out value)){value=new Care{Day=day};care.Add(id,value);}
            if(value.Day!=day){value.Day=day;value.Used=0;}
            return value;
        }
        void Reserve(string id,long now) { var value=CareFor(id);value.Used++;value.LastAt=now; }
        void Event(string id) { progress[id]=1;XP+=8; }
        static FarmUnit Crop(string id,string name,string art,int days,int total,int moisture,string status)
        { return new FarmUnit{Id=id,Name=name,Art=art,Kind="crop",Days=days,Total=total,Moisture=moisture,Status=status}; }
        static FarmProduct Product(string id,string name,string art,string kind,int days,int cost,double min,double max,params string[] seasons)
        { return new FarmProduct{Id=id,Name=name,Art=art,Kind=kind,Days=days,Cost=cost,ValueMin=min,ValueMax=max,Seasons=seasons}; }
        static FarmGood Good(string id,string name,string art,string category,int cost,int limit,string description)
        { return new FarmGood{Id=id,Name=name,Art=art,Category=category,Cost=cost,Limit=limit,Description=description}; }
        public FarmModel(long nowMs=-1)
        {
            if(!Sync(Now(nowMs)))throw new ArgumentOutOfRangeException("nowMs");
            Plots.Add(Crop("A01","小番茄","tomato",18,65,32,"growing"));
            Plots.Add(Crop("A02","甜脆胡萝卜","carrot",75,75,58,"ready"));
            Plots.Add(Crop("A03","奶油生菜","lettuce",12,35,53,"growing"));
            Plots.Add(Crop("A04","空闲地块","empty",0,0,45,"empty"));
            Plots.Add(Crop("A05","上海青","bokchoy",9,30,48,"growing"));
            Plots.Add(Crop("A06","四季香葱","onion",21,45,55,"growing"));
            Animals.Add(new FarmUnit{Id="P01",Name="生态黑猪",Art="pig",Kind="animal",Days=135,Total=150,Weight=78,Status="growing"});
            Animals.Add(new FarmUnit{Id="C01",Name="林下土鸡",Art="chicken",Kind="animal",Days=86,Total=120,Weight=1.6,Status="growing"});
            Animals.Add(new FarmUnit{Id="G01",Name="山地黑山羊",Art="goat",Kind="animal",Days=180,Total=180,Weight=32,Status="ready"});
            Products.Add(Product("lettuce","奶油生菜","lettuce","crop",35,8,10,24,"spring","autumn"));
            Products.Add(Product("radish","樱桃萝卜","radish","crop",28,6,12,30,"spring","autumn","winter"));
            Products.Add(Product("carrot","甜脆胡萝卜","carrot","crop",75,10,12,28,"autumn","winter"));
            Products.Add(Product("tomato","小番茄","tomato","crop",65,12,24,48,"spring","summer"));
            Products.Add(Product("greens","上海青","bokchoy","crop",30,8,10,24,"autumn","winter","spring"));
            Products.Add(Product("onion","四季香葱","onion","crop",45,6,8,24,"spring","summer","autumn","winter"));
            Products.Add(Product("pig","生态黑猪","pig","animal",150,880,1260,2040,"spring","summer","autumn","winter"));
            Products.Add(Product("chicken","林下土鸡","chicken","animal",120,98,102,176,"spring","summer","autumn"));
            Products.Add(Product("goat","山地黑山羊","goat","animal",180,680,816,1584,"spring","autumn"));
            Goods.Add(Good("feed-pack","日常饲料包","feed","supplies",30,5,"3份饲料，按需照料牧场伙伴"));
            Goods.Add(Good("fertilizer","田园营养肥","fertilizer","supplies",20,5,"1份养护物资，实际使用遵循农场建议"));
            Goods.Add(Good("care-tools","农事工具","tools","supplies",25,5,"1件工具，收入农场物资仓"));
            Goods.Add(Good("seed-box","当季种子盒","seed","supplies",40,5,"1份种子礼包，供后续种植体验"));
            Goods.Add(Good("garden-sign","我的田园木牌","sign","gifts",80,3,"1件田园装饰，记录自己的小天地"));
            Goods.Add(Good("harvest-frame","丰收纪念相框","frame","gifts",100,3,"1件丰收装饰，留住田园好时光"));
            Goods.Add(Good("care-bundle","日常照料组合","bundle","supplies",65,3,"3份饲料、1份肥料和1件工具"));
            Goods.Add(Good("season-gift","四季田园礼盒","gift","gifts",90,3,"5份饲料与2份肥料，按需使用"));
        }
        public FarmCareStatus CareStatus(string id,long nowMs=-1)
        {
            long now=Now(nowMs);var result=new FarmCareStatus{Allowed=false,Reason="照料对象或时间无效",Remaining=0};
            if(!Sync(now)||!AssetsValid())return result;
            var unit=Unit(id);if(unit==null)return result;
            var value=CareFor(id);result.Remaining=Math.Max(0,2-value.Used);
            if(DeviceStatus!="idle"){result.Reason="设备忙碌或状态待核查，请先查看设备面板";return result;}
            if(unit.Status!="growing"){result.Reason="仅生长中的种养对象可以照料";return result;}
            if(unit.Kind=="crop"&&(unit.Moisture<0||unit.Moisture>100)){result.Reason="土壤湿度数据无效";return result;}
            if(unit.Kind=="crop"&&unit.Moisture>=65){result.Reason="土壤湿度已充足，暂不需要浇水";return result;}
            if(unit.Kind=="animal"&&Feed<1){result.Reason="饲料不足，先领取或补充饲料";return result;}
            if(value.LastAt.HasValue&&value.LastAt.Value>now){result.Reason="设备时间早于已有照料，请校准时间";return result;}
            if(value.Used>=2){result.Reason="今天已照料2次，明天再来";result.NextAt=(now+ChinaOffset)/DayMs*DayMs+DayMs-ChinaOffset;return result;}
            long interval=unit.Kind=="crop"?6*Hour:4*Hour;
            if(value.LastAt.HasValue&&now-value.LastAt.Value<interval)
            { result.Reason=unit.Kind=="crop"?"距离上次浇水不足6小时":"距离上次投喂不足4小时";result.NextAt=value.LastAt.Value+interval;return result; }
            result.Allowed=true;result.Reason=unit.Kind=="crop"?"可以浇水":"可以投喂";return result;
        }
        public FarmResult BeginWater(string id,long nowMs=-1)
        {
            long now=Now(nowMs);var unit=Unit(id);if(unit==null||unit.Kind!="crop")return No("请选择自己的生长中地块");
            var check=CareStatus(id,now);if(!check.Allowed)return No(check.Reason);
            Reserve(id,now);DeviceUnitId=id;DeviceStatus="sending";DeviceGeneration++;
            return Yes("模拟灌溉指令已发送，尚未收到设备回执");
        }
        public FarmResult AcknowledgeWater(long nowMs=-1,int expectedGeneration=-1)
        {
            if(expectedGeneration>=0&&expectedGeneration!=DeviceGeneration)return No("旧设备回执已失效");
            if(DeviceStatus!="sending")return No("当前没有等待启动确认的指令");
            long now=Now(nowMs);if(!Sync(now)||!AssetsValid()||!CanAdd(XP,8))return No("当前时间或成长记录无效");
            Care value=CareFor(DeviceUnitId);if(value.LastAt>now)return No("设备时间早于已发送指令");
            DeviceStatus="running";Event("care");return Yes("已收到模拟设备执行回执，开始灌溉");
        }
        public FarmResult RequestStopWater()
        {
            if(DeviceStatus!="running")return No("只有执行中的模拟灌溉可以请求停止");
            DeviceStatus="stopping";return Yes("停止指令已发送，等待模拟停止回执");
        }
        public FarmResult ConfirmStopWater(int expectedGeneration=-1)
        {
            if(expectedGeneration>=0&&expectedGeneration!=DeviceGeneration)return No("旧停止回执已失效");
            if(DeviceStatus!="stopping")return No("当前没有等待停止确认的指令");
            var unit=Unit(DeviceUnitId);if(unit==null)return No("原照料对象已失效，请核查设备");
            unit.Moisture=Math.Min(68,unit.Moisture+8);DeviceStatus="idle";DeviceUnitId="";
            return Yes("已收到模拟阀门关闭回执，本次照料已记录");
        }
        public FarmResult MarkWaterUnknown()
        {
            if(DeviceStatus=="idle")return No("当前没有待核查指令");
            DeviceStatus="unknown";DeviceGeneration++;return Yes("模拟设备回执未知，请人工核查；不会自动重发或更新湿度");
        }
        public FarmResult ReconcileWater()
        {
            if(DeviceStatus!="unknown")return No("只有未知状态可以进行模拟人工核查");
            DeviceStatus="idle";DeviceUnitId="";DeviceGeneration++;
            return Yes("模拟核查已确认阀门关闭；原次数和照料间隔继续保留");
        }
        public FarmResult FeedAnimal(string id,long nowMs=-1)
        {
            long now=Now(nowMs);var unit=Unit(id);if(unit==null||unit.Kind!="animal")return No("请选择自己的牧场伙伴");
            var check=CareStatus(id,now);if(!check.Allowed)return No(check.Reason);
            if(!CanAdd(XP,8))return No("成长记录超出范围，本次未投喂");
            Reserve(id,now);Feed--;Event("care");return Yes("模拟喂料设备已确认，消耗1份饲料；请间隔4小时再照料");
        }
        public FarmResult Adopt(string productId,string unitId=null,long nowMs=-1)
        {
            if(!Sync(Now(nowMs))||!AssetsValid())return No("当前日期或资产状态无效");
            var product=Products.Find(x=>x.Id==productId);if(product==null)return No("认养品种不存在");
            if(!CanAdd(XP,8))return No("成长记录超出范围");
            if(product.Kind=="crop")
            {
                var plot=unitId==null?Plots.Find(x=>x.Status=="empty"):Plots.Find(x=>x.Id==unitId);
                if(plot==null||plot.Status!="empty")return No("请选择自己的空闲地块");
                plot.Name=product.Name;plot.Art=product.Art;plot.Days=0;plot.Total=product.Days;plot.Moisture=45;plot.Status="growing";
                // Daily device allowance belongs to the plot; a purchase cannot reset its cooldown.
            }
            else
            {
                if(Animals.Count>=40)return No("本次体验牧场对象已达上限");
                animalSerial++;Animals.Add(new FarmUnit{Id="N"+animalSerial.ToString("00"),Name=product.Name,Art=product.Art,Kind="animal",Days=0,Total=product.Days,Status="growing"});
            }
            XP+=8;return Yes("离线示例认养已完成，种养对象已加入农场；没有真实付款或工作人员派单");
        }
        public FarmResult Harvest(string unitId,long nowMs=-1)
        {
            if(!Sync(Now(nowMs))||!AssetsValid())return No("当前日期或资产状态无效");
            var unit=Unit(unitId);if(unit==null||unit.Status!="ready")return No("只可收获本人已成熟的种养对象");
            if(!CanAdd(XP,8)||!CanAdd(unit.Kind=="crop"?Crops:Meat,1))return No("收获数量超出范围");
            if(unit.Kind=="crop")
            { Crops++;unit.Name="空闲地块";unit.Art="empty";unit.Status="empty";unit.Days=0;unit.Total=0; }
            else{Meat++;unit.Status="harvested";}
            Event("harvest");return Yes("模拟采收或处理已完成，收获已收入仓库；配送需另行演示确认");
        }
        public FarmResult CollectEggs(long nowMs=-1)
        {
            if(!Sync(Now(nowMs))||!AssetsValid())return No("当前日期或资产状态无效");
            if(EggsAvailable<1)return No("本次演示鸡蛋已收取，不会自动补产");
            if(!CanAdd(Eggs,EggsAvailable)||!CanAdd(XP,8))return No("收获数量超出范围");
            int quantity=EggsAvailable;Eggs+=quantity;EggsAvailable=0;Event("harvest");return Yes(quantity+"枚示例鸡蛋已收入仓库");
        }
        int Bought(string id) { int value;return bought.TryGetValue(id,out value)?value:0; }
        public int RemainingStock(string id,long nowMs=-1)
        {
            if(!Sync(Now(nowMs)))return 0;
            var good=Goods.Find(x=>x.Id==id);return good==null?0:Math.Max(0,good.Limit-Bought(id));
        }
        public FarmResult AddCart(string goodId,int delta,long nowMs=-1)
        {
            if(!Sync(Now(nowMs))||!AssetsValid())return No("当前日期或资产状态无效");
            var good=Goods.Find(x=>x.Id==goodId);if(good==null)return No("积分商品不存在");
            int quantity;Cart.TryGetValue(goodId,out quantity);long next=(long)quantity+delta;
            if(next<0||next>Math.Min(5,good.Limit-Bought(goodId)))return No("数量超出购物车或今日限购额度");
            if(next==0)Cart.Remove(goodId);else Cart[goodId]=(int)next;
            return Yes(next==0?"商品已移出购物车":"购物车数量已更新");
        }
        public FarmQuote QuoteCart(bool coupon)
        {
            var quote=new FarmQuote{Valid=true,Reason="积分兑换，仅为演示"};
            foreach(var item in Cart)
            {
                var good=Goods.Find(x=>x.Id==item.Key);
                if(good==null||item.Value<1||item.Value>Math.Min(5,good.Limit-Bought(item.Key)))
                {quote.Valid=false;quote.Reason="部分商品超出今日限购或数量无效";return quote;}
                quote.Subtotal+=good.Cost*item.Value;quote.Count+=item.Value;
            }
            if(quote.Count==0){quote.Valid=false;quote.Reason="购物车还是空的";}
            if(coupon&&(!CouponAvailable||quote.Subtotal<60))
            { quote.Valid=false;quote.Reason=!CouponAvailable?"积分券已使用":"未达到满60积分的用券门槛"; }
            quote.Discount=coupon&&CouponAvailable&&quote.Subtotal>=60?20:0;
            quote.Total=quote.Subtotal-quote.Discount;return quote;
        }
        public FarmResult Checkout(bool coupon,string transactionId,long nowMs=-1)
        {
            if(transactionId==null||!KeyPattern.IsMatch(transactionId))return No("兑换事务编号无效");
            FarmReceipt previous;if(purchases.TryGetValue(transactionId,out previous))return Yes("已恢复原兑换结果，本次没有再次扣分或发物资");
            if(!Sync(Now(nowMs))||!AssetsValid())return No("当前日期或资产状态无效");
            var quote=QuoteCart(coupon);if(!quote.Valid)return No(quote.Reason);
            if(Points<quote.Total)return No("积分不足，先完成任务或签到；购物车保留");
            int feed=0,fertilizer=0,tools=0,seeds=0,decorations=0;
            foreach(var item in Cart)
            {
                switch(item.Key)
                {
                    case "feed-pack":feed+=3*item.Value;break;
                    case "fertilizer":fertilizer+=item.Value;break;
                    case "care-tools":tools+=item.Value;break;
                    case "seed-box":seeds+=item.Value;break;
                    case "garden-sign":case "harvest-frame":decorations+=item.Value;break;
                    case "care-bundle":feed+=3*item.Value;fertilizer+=item.Value;tools+=item.Value;break;
                    case "season-gift":feed+=5*item.Value;fertilizer+=2*item.Value;break;
                }
            }
            if(!CanAdd(Feed,feed)||!CanAdd(Fertilizer,fertilizer)||!CanAdd(Tools,tools)||!CanAdd(Seeds,seeds)||!CanAdd(Decorations,decorations))
                return No("物资数量超出范围，本次未兑换");
            var receipt=new FarmReceipt{Id=transactionId,Day=day,Count=quote.Count,Subtotal=quote.Subtotal,Discount=quote.Discount,Total=quote.Total,
                Summary=string.Join("、",Cart.Select(item=>Goods.Find(x=>x.Id==item.Key).Name+" ×"+item.Value).ToArray())};
            Points-=quote.Total;Feed+=feed;Fertilizer+=fertilizer;Tools+=tools;Seeds+=seeds;Decorations+=decorations;
            if(coupon)coupons--;
            foreach(var item in Cart)bought[item.Key]=Bought(item.Key)+item.Value;
            Cart.Clear();Receipts.Add(receipt);purchases.Add(transactionId,receipt);
            return Yes("积分兑换成功，物资已收入同一仓库；没有现金支付");
        }
        public FarmResult ClaimSignIn(long nowMs=-1)
        {
            long now=Now(nowMs);if(!Sync(now)||!AssetsValid())return No("当前日期或资产状态无效，不能回退签到");
            if(signedDays.Contains(day))return No("今天已经签到，明天再来");
            int index=CurrentStreak(day)%7,points=index==0?20:index==1?30:index==3?40:index==5?60:0;
            if(!CanAdd(Points,points)||!CanAdd(XP,10)||(index==2&&!CanAdd(Feed,1))||(index==4&&!CanAdd(Fertilizer,1))||(index==6&&!CanAdd(coupons,1)))return No("签到奖励超出范围");
            Points+=points;XP+=10;if(index==2)Feed++;if(index==4)Fertilizer++;if(index==6)coupons++;
            signedDays.Add(day);SignStreak=CurrentStreak(day);return Yes("今日签到成功："+SignLabels[index]+"（演示）");
        }
        public bool SignedToday(long nowMs=-1) { return Sync(Now(nowMs))&&signedDays.Contains(day); }
        public string SignRewardText(long nowMs=-1)
        { if(!Sync(Now(nowMs)))return "请校准设备日期";return signedDays.Contains(day)?"今天已签到，明天再来":SignLabels[CurrentStreak(day)%7]; }
        public FarmResult VisitShop(long nowMs=-1)
        {
            if(!Sync(Now(nowMs))||!AssetsValid())return No("当前日期或资产状态无效");
            if(!progress.ContainsKey("browse")){if(!CanAdd(XP,8))return No("成长记录超出范围");Event("browse");}
            return Yes("已记录今日逛商城资格，任务奖励需主动领取");
        }
        public bool TaskReady(string id,long nowMs=-1)
        { return Sync(Now(nowMs))&&TaskIds.Contains(id)&&progress.ContainsKey(id)&&!taskClaims.Contains(id); }
        public bool TaskClaimed(string id,long nowMs=-1) { return Sync(Now(nowMs))&&taskClaims.Contains(id); }
        public FarmResult ClaimTask(string id,long nowMs=-1)
        {
            if(!Sync(Now(nowMs))||!AssetsValid())return No("当前日期或资产状态无效");
            if(!TaskIds.Contains(id)||!progress.ContainsKey(id))return No("先完成这项今日任务，再领取积分");
            if(taskClaims.Contains(id))return No("今日任务奖励已经领取");
            int reward=id=="browse"?10:id=="care"?15:20;if(!CanAdd(Points,reward))return No("奖励数量超出范围");
            Points+=reward;taskClaims.Add(id);return Yes("今日任务奖励已领取："+reward+"积分（演示）");
        }
        public FarmResult ClaimWelcome(long nowMs=-1)
        {
            if(!Sync(Now(nowMs))||!AssetsValid())return No("当前日期或资产状态无效");
            if(WelcomeClaimed)return No("新人礼只能领取一次");
            if(!CanAdd(Points,30)||!CanAdd(Feed,2))return No("福利数量超出范围");
            Points+=30;Feed+=2;WelcomeClaimed=true;return Yes("新人礼已领取：30积分 + 2份饲料（演示）");
        }
        public FarmResult ClaimAd(bool completed,string receiptId,long nowMs=-1)
        {
            if(!Sync(Now(nowMs))||!AssetsValid())return No("当前日期或资产状态无效");
            if(!completed)return No("完整观看演示片段后才可领取");
            if(receiptId==null||!KeyPattern.IsMatch(receiptId))return No("演示广告回执编号无效");
            if(adReceipts.Contains(receiptId))return No("本段广告奖励已领取");
            if(AdToday>=3)return No("今日演示广告奖励已达3次上限");
            if(!CanAdd(Points,20)||!CanAdd(Feed,1))return No("福利数量超出范围");
            Points+=20;Feed++;AdToday++;adReceipts.Add(receiptId);return Yes("演示奖励到账：20积分 + 1份饲料；未接真实广告");
        }
        public List<FarmProduct> RankedProducts(int month,string kind=null)
        {
            if(month<1||month>12||kind!=null&&kind!="crop"&&kind!="animal")return new List<FarmProduct>();
            string season=month>=3&&month<=5?"spring":month>=6&&month<=8?"summer":month>=9&&month<=11?"autumn":"winter";
            return Products.Where(x=>kind==null||x.Kind==kind).Select(x=>new FarmProduct{Id=x.Id,Name=x.Name,Art=x.Art,Kind=x.Kind,Days=x.Days,Cost=x.Cost,ValueMin=x.ValueMin,ValueMax=x.ValueMax,Seasons=(string[])x.Seasons.Clone(),Recommended=x.Seasons.Contains(season)})
                .OrderByDescending(x=>x.Recommended).ThenBy(x=>x.Days).ThenByDescending(x=>(x.ValueMin+x.ValueMax)/2-x.Cost).ToList();
        }
    }
}
