using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.EventSystems;
using U = Hegeng.FarmUI;

namespace Hegeng
{
    public sealed class FarmApp : MonoBehaviour
    {
        FarmModel model;
        Canvas canvas;
        RectTransform safe,header,body,footer,content,modalRoot,modalPanel,modalContent,toastRoot;
        ScrollRect scroll;
        Text balance,toastLabel;
        string page="home",farmTab="crop",shopTab="adoption",circle="全部",cameraKey="farm-estate",selectedUnit="plot-1",renderedKey="home:";
        readonly Dictionary<string,float> positions=new Dictionary<string,float>();
        readonly Dictionary<string,Image> farmTileImages=new Dictionary<string,Image>();
        RectTransform farmCarePanel;
        readonly HashSet<string> joined=new HashSet<string>(),friends=new HashSet<string>{"f1"},requested=new HashSet<string>(),liked=new HashSet<string>(),hidden=new HashSet<string>();
        readonly HashSet<string> shipping=new HashSet<string>();
        readonly List<Post> posts=new List<Post>();
        readonly List<string> messages=new List<string>();
        readonly List<string> deliveries=new List<string>();
        Func<bool> dirty;
        GameObject confirmLayer;
        Coroutine toastRoutine,adRoutine;
        bool paused,deviceBusy,adCompleted;
        int adSeconds;
        string deviceScenario="normal";
        const string ShareUrl="https://wthpein010-dev.github.io/hejian-farm-demo/";
        static long Now=>DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        string PositionKey=>page+":"+(page=="farm"?farmTab:page=="shop"?shopTab:page=="community"?circle:"");
        readonly string[] friendNames={"林间清风","老周的菜园","麦田守望"};
        readonly string[] circles={"种菜交流","牧场日记","丰收分享"};
        sealed class Post { public string Id,Author,Circle,Text,Photo;public int Likes;public bool Mine;public List<string> Comments=new List<string>(); }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Launch(){if(FindObjectOfType<FarmApp>()==null)new GameObject("合耕小舍").AddComponent<FarmApp>();}
        void Awake()
        {
            Application.targetFrameRate=60;Screen.orientation=ScreenOrientation.Portrait;
            model=new FarmModel(Now);U.Font=Resources.Load<Font>("Fonts/NotoSansCJKsc");
            if(U.Font==null){Debug.LogError("Bundled Chinese font missing");return;}
            selectedUnit=model.Plots[0].Id;
            posts.Add(new Post{Id="p1",Author="林间清风",Circle="种菜交流",Text="早上来看看菜地，叶子又长大了一圈。按需照料，慢慢等一份好收成。",Photo="bokchoy",Likes=28,Comments=new List<string>{"老周：这一畦长势真好！"}});
            posts.Add(new Post{Id="p2",Author="老周的菜园",Circle="丰收分享",Text="今天收到了新鲜蔬菜，家里的餐桌也有了田园味道。晒晒我的这一份丰收。",Photo="carrot",Likes=36});
            posts.Add(new Post{Id="p3",Author="麦田守望",Circle="牧场日记",Text="小猪正在院子里散步。换个第一视角，看看它眼里的农场。",Photo="pig",Likes=19});
            var c=U.Rect("Canvas",transform);canvas=c.gameObject.AddComponent<Canvas>();canvas.renderMode=RenderMode.ScreenSpaceOverlay;
            var scaler=c.gameObject.AddComponent<CanvasScaler>();scaler.uiScaleMode=CanvasScaler.ScaleMode.ScaleWithScreenSize;scaler.referenceResolution=new Vector2(432,900);scaler.matchWidthOrHeight=0;
            c.gameObject.AddComponent<GraphicRaycaster>();U.Surface(c,FarmTheme.Canvas,0);
            safe=U.Rect("Safe area",c);ApplySafeArea();
            if(EventSystem.current==null){var e=new GameObject("EventSystem",typeof(EventSystem),typeof(StandaloneInputModule));e.transform.SetParent(transform);}
            header=U.Rect("Header",safe);header.anchorMin=new Vector2(0,1);header.anchorMax=Vector2.one;header.pivot=new Vector2(.5f,1);header.sizeDelta=new Vector2(0,68);
            body=U.Rect("Page",safe);U.Fill(body,0,68,0,84);
            footer=U.Rect("Navigation",safe);footer.anchorMin=footer.anchorMax=new Vector2(.5f,0);footer.anchorMin=new Vector2(0,0);footer.anchorMax=new Vector2(1,0);footer.pivot=new Vector2(.5f,0);footer.sizeDelta=new Vector2(0,84);
            BuildHeader();Render(false);
        }
        void ApplySafeArea()
        {
            var a=Screen.safeArea;safe.anchorMin=new Vector2(a.xMin/Screen.width,a.yMin/Screen.height);safe.anchorMax=new Vector2(a.xMax/Screen.width,a.yMax/Screen.height);safe.offsetMin=safe.offsetMax=Vector2.zero;
        }
        void BuildHeader()
        {
            U.Clear(header);U.Surface(header,FarmTheme.Paper,0);
            var logo=U.Box(header,FarmTheme.Action,0,12);U.Place(logo,18,13,40,40);var icon=U.Icon(logo,"leaf",FarmTheme.Ink);U.Fill(icon,9,9,9,9);
            var name=U.Label(header,"合耕小舍",21,null,true);U.Place((RectTransform)name.transform,68,2,220,42);
            var tag=U.Label(header,"把田园，放在身边",12,FarmTheme.Secondary);U.Place((RectTransform)tag.transform,68,41,200,20);
            var wallet=U.Button(header,"",()=>Navigate("profile"),false,true,50);U.Place((RectTransform)wallet.transform,320,9,94,50);
            balance=U.Label(wallet.transform,model.Points+" 积分",15,null,true,0,TextAnchor.MiddleCenter);U.Fill((RectTransform)balance.transform,3,0,3,0);
        }
        void BuildFooter()
        {
            U.Clear(footer);U.Surface(footer,FarmTheme.Paper,0);
            var line=U.Box(footer,FarmTheme.Line,0,0);U.Place(line,0,0,432,1);
            var row=U.Row(footer,82,0);U.Fill(row,3,0,3,0);
            string[] ids={"farm","shop","home","live","profile"},labels={"我的农场","商城","主页","实景","我的"},icons={"farm","shop","home","camera","user"};
            string owner=page=="community"||page=="friends"||page=="activities"?"home":page;
            for(int i=0;i<ids.Length;i++)
            {
                string target=ids[i];var b=U.Button(row,"",()=>Navigate(target),false,true,82);b.GetComponent<Image>().color=Color.clear;
                var mark=U.Box(b.transform,owner==target?FarmTheme.Action:Color.clear,0,20);mark.anchorMin=mark.anchorMax=new Vector2(.5f,1);mark.pivot=new Vector2(.5f,1);mark.anchoredPosition=new Vector2(0,-6);mark.sizeDelta=new Vector2(42,40);
                var icon=U.Icon(mark,icons[i],FarmTheme.Ink);U.Fill(icon,8,8,8,8);
                var t=U.Label(b.transform,labels[i],13,FarmTheme.Ink,false,0,TextAnchor.MiddleCenter);var rt=(RectTransform)t.transform;rt.anchorMin=new Vector2(0,0);rt.anchorMax=new Vector2(1,0);rt.pivot=new Vector2(.5f,0);rt.anchoredPosition=new Vector2(0,9);rt.sizeDelta=new Vector2(0,25);
            }
        }
        void Navigate(string next)
        {
            if(modalRoot!=null){TryClose(()=>Navigate(next));return;}
            if(next==page){if(renderedKey!=PositionKey)Render(false);return;}
            SavePosition();page=next;Render(false);
        }
        void SavePosition(){if(content!=null)positions[renderedKey]=Mathf.Max(0,content.anchoredPosition.y);}
        void Render(bool preserve=true)
        {
            if(preserve)SavePosition();farmTileImages.Clear();farmCarePanel=null;U.Clear(body);scroll=U.Scroll(body,out content);BuildFooter();UpdateBalance();
            switch(page){case "home":Home();break;case "farm":Farm();break;case "shop":Shop();break;case "live":Live();break;case "profile":Profile();break;case "community":Community();break;case "friends":Friends();break;case "activities":Activities();break;}
            renderedKey=PositionKey;U.Spacer(content,12);StartCoroutine(RestorePosition(positions.TryGetValue(PositionKey,out var y)?y:0));
        }
        IEnumerator RestorePosition(float y){yield return null;Canvas.ForceUpdateCanvases();if(content!=null){float max=Mathf.Max(0,content.rect.height-scroll.viewport.rect.height);content.anchoredPosition=new Vector2(0,Mathf.Min(y,max));scroll.velocity=Vector2.zero;}}
        void UpdateBalance(){if(balance!=null)balance.text=model.Points+" 积分";}
        void Title(string title,string subtitle,Action back=null)
        {
            var row=U.Row(content,40);if(back!=null)U.IconButton(row,"back",back);
            U.Label(row,title,28,null,true,40);if(!string.IsNullOrEmpty(subtitle))U.Label(content,subtitle,15,FarmTheme.Secondary,false,40);
        }
        RectTransform Hero(Transform parent,string photo,string eyebrow,string title,string subtitle,float h=238)
        {
            var r=U.Rect("Landscape",parent);U.Height(r,h);var image=U.Photo(r,photo,h);U.Fill((RectTransform)image.transform.parent);
            var tint=U.Box(r,new Color(.07f,.11f,.07f,.53f),0,0);tint.anchorMin=Vector2.zero;tint.anchorMax=new Vector2(1,.57f);tint.offsetMin=tint.offsetMax=Vector2.zero;
            var badge=U.Box(r,FarmTheme.Paper,0,9);U.Place(badge,16,16,136,30);var e=U.Label(badge,eyebrow,13,FarmTheme.Ink,true,0,TextAnchor.MiddleCenter);U.Fill((RectTransform)e.transform);
            var text=U.VBox(r,4);text.anchorMin=Vector2.zero;text.anchorMax=new Vector2(1,0);text.pivot=new Vector2(.5f,0);text.anchoredPosition=new Vector2(0,17);text.sizeDelta=new Vector2(-36,88);
            U.Label(text,title,27,Color.white,true,40);U.Label(text,subtitle,15,Color.white,false,43);return r;
        }
        void Note(Transform parent,string text){var c=U.Card(parent,0,13,FarmTheme.Soft);U.Label(c,text,14,FarmTheme.Secondary,false,Mathf.Max(42,Mathf.Ceil(text.Length/24f)*22));}
        void Heading(Transform parent,string text,string detail=null,Action action=null)
        {
            var r=U.Row(parent,48);U.Label(r,text,21,null,true,40);
            if(detail!=null){var b=U.Button(r,detail,action,false,true,48);U.Width((RectTransform)b.transform,100);b.GetComponent<Image>().color=Color.clear;b.GetComponentInChildren<Text>().fontSize=14;}
        }
        void Home()
        {
            Hero(content,"farm-estate","田园生活","一份耕耘，一起收获","种一畦菜，认养一份田园好时光。");
            var welcome=U.Card(content,12,18,FarmTheme.Header);
            var row=U.Row(welcome,40);U.Label(row,"今日田园小确幸",21,null,true);U.Label(row,DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(8)).ToString("MM月dd日"),14,FarmTheme.Secondary,false,40,TextAnchor.MiddleRight);
            U.Label(welcome,model.SignedToday(Now)?"今天的心意已收好，明天再相见。":"来签到，攒积分，把丰收带回家。",16,FarmTheme.Secondary,false,32);
            U.Button(welcome,model.SignedToday(Now)?"今日已签到":"签到领"+model.SignRewardText(Now),()=>{Act(model.ClaimSignIn(Now));Render();},true,!model.SignedToday(Now),54,"calendar");
            var quick=U.Row(content,86,10);Quick(quick,"friends","农友","看看好友的田园",()=>Navigate("friends"));Quick(quick,"gift","活动中心","任务与七日好礼",()=>Navigate("activities"));
            Heading(content,"田园圈子","全部圈子",()=>Navigate("community"));
            var circlesRow=U.Row(content,80,8);
            for(int i=0;i<circles.Length;i++){string c=circles[i];var b=U.Button(circlesRow,c,()=>{circle=c;Navigate("community");},false,true,80);b.GetComponentInChildren<Text>().fontSize=16;}
            Heading(content,"田园动态","发动态",Compose);
            foreach(var post in posts.Where(p=>!hidden.Contains(p.Id)).Take(2))PostCard(content,post);
            U.Button(content,"去社区，聊聊田园生活",()=>Navigate("community"),false, true,54,"message");
            U.Label(content,"离线体验 · 示例社区与种养数据",13,FarmTheme.Secondary,false,26,TextAnchor.MiddleCenter);
        }
        void Quick(Transform parent,string icon,string title,string detail,Action click)
        {
            var b=U.Button(parent,"",click,false,true,86);b.GetComponent<Image>().color=FarmTheme.Paper;
            var i=U.Icon(b.transform,icon,FarmTheme.Primary);U.Place(i,15,17,25,25);
            var t=U.Label(b.transform,title,18,null,true);U.Place((RectTransform)t.transform,50,12,136,28);
            var s=U.Label(b.transform,detail,13,FarmTheme.Secondary);U.Place((RectTransform)s.transform,15,48,160,25);
        }
        void Farm()
        {
            Title("我的农场","亲手照料，静候一份田园收获");
            var tabs=U.Row(content,52);Segment(tabs,"农田",farmTab=="crop",()=>{SavePosition();farmTab="crop";selectedUnit=model.Plots[0].Id;Render(false);});Segment(tabs,"牧场",farmTab=="animal",()=>{SavePosition();farmTab="animal";selectedUnit=model.Animals[0].Id;Render(false);});
            Hero(content,farmTab=="crop"?"farm-estate":"livestock",farmTab=="crop"?"我的田园":"我的牧场",farmTab=="crop"?"把日子种成喜欢的样子":"和牧场伙伴一起长大",farmTab=="crop"?"看长势、按需浇水，等一份新鲜。":"投喂有节制，每一份照料都算数。",218);
            var units=farmTab=="crop"?model.Plots:model.Animals;
            for(int i=0;i<units.Count;i+=2)
            {
                var row=U.Row(content,174,10);
                for(int j=i;j<Math.Min(i+2,units.Count);j++)
                {
                    var unit=units[j];var b=U.Button(row,"",()=>SelectFarmUnit(unit.Id),false,true,174);var tile=b.GetComponent<Image>();tile.color=selectedUnit==unit.Id?FarmTheme.Soft:FarmTheme.Paper;farmTileImages.Add(unit.Id,tile);
                    var ph=U.Rect("Picture",b.transform);U.Place(ph,8,8,174,99);var picture=U.Photo(ph,unit.Art??"empty",99);U.Fill((RectTransform)picture.transform.parent);
                    var label=U.Label(b.transform,UnitName(unit),16,null,true);U.Place((RectTransform)label.transform,12,106,166,43);
                    var status=U.Label(b.transform,UnitStatus(unit),13,FarmTheme.Secondary);U.Place((RectTransform)status.transform,12,150,166,23);
                }
            }
            var selected=units.Find(u=>u.Id==selectedUnit)??units[0];farmCarePanel=U.Card(content);BuildFarmCare(selected);
            if(model.DeviceStatus!="idle")U.Button(content,"查看灌溉状态 · "+DeviceLabel(),()=>Device(model.DeviceUnitId),false,true,54,"water");
            if(farmTab=="animal")
            {var eggs=U.Card(content);U.Label(eggs,"今天的鲜鸡蛋",21,null,true,32);U.Label(eggs,model.EggsAvailable>0?"示例登记 "+model.EggsAvailable+" 枚，手动收取后进入仓库。":"今日示例鸡蛋已收入仓库。",16,FarmTheme.Secondary,false,52);U.Button(eggs,model.EggsAvailable>0?"收取鸡蛋":"今日已收取",()=>{Act(model.CollectEggs());Render();},true,model.EggsAvailable>0,54,"gift");}
            var q=U.Row(content,80);Quick(q,"gift","我的仓库","看看攒下的收获",Warehouse);Quick(q,"calendar","每日农事","查看今日待办",()=>Navigate("activities"));
            Note(content,"种养与设备为离线演示。次数、间隔与农时为方案样本，真实操作需农场确认。");
        }
        void SelectFarmUnit(string id)
        {
            if(page!="farm"||farmCarePanel==null||selectedUnit==id)return;
            var units=farmTab=="crop"?model.Plots:model.Animals;
            var selected=units.Find(unit=>unit.Id==id);if(selected==null)return;
            Vector2 position=content.anchoredPosition;selectedUnit=id;
            foreach(var tile in farmTileImages)if(tile.Value!=null)tile.Value.color=tile.Key==id?FarmTheme.Soft:FarmTheme.Paper;
            // Keep the existing viewport, hero and photo tiles alive. Only the care
            // panel's text/actions change, with layout settled before this frame renders.
            U.Clear(farmCarePanel);BuildFarmCare(selected);
            LayoutRebuilder.ForceRebuildLayoutImmediate(content);Canvas.ForceUpdateCanvases();
            scroll.StopMovement();float maximum=Mathf.Max(0,content.rect.height-scroll.viewport.rect.height);
            content.anchoredPosition=new Vector2(position.x,Mathf.Clamp(position.y,0,maximum));SavePosition();
        }
        void BuildFarmCare(FarmUnit selected)
        {
            var card=farmCarePanel;
            U.Label(card,UnitName(selected)+" · "+UnitStatus(selected),20,null,true,56);
            if(selected.Status=="empty"||selected.Status=="harvested")
            {U.Label(card,"选一份当季种养，开启新的田园时光。",16,FarmTheme.Secondary,false,50);U.Button(card,"去选择种养",()=>{shopTab="adoption";Navigate("shop");},true,true,54,"leaf");}
            else
            {
                var status=model.CareStatus(selected.Id,Now);
                U.Label(card,selected.Kind=="crop"?"土壤湿度 "+selected.Moisture+"%":"当前饲料 "+model.Feed+" 份",18,null,true,29);
                Progress(card,selected.Kind=="crop"?selected.Moisture/100f:Mathf.Min(1,selected.Days/(float)Math.Max(1,selected.Total)));
                U.Label(card,"今日剩余 "+status.Remaining+" 次 · "+(selected.Kind=="crop"?"间隔6小时":"间隔4小时"),15,FarmTheme.Secondary,false,29);
                U.Label(card,status.Reason+(status.NextAt.HasValue?"\n下次："+ChinaTime(status.NextAt.Value):""),15,FarmTheme.Secondary,false,status.NextAt.HasValue?56:29);
                var actions=U.Row(card,54);
                U.Button(actions,selected.Kind=="crop"?"浇水":"投喂",()=>{if(selected.Kind=="crop")Device(selected.Id);else{Act(model.FeedAnimal(selected.Id,Now));Render();}},true,status.Allowed&&!deviceBusy,54,selected.Kind=="crop"?"water":"leaf");
                U.Button(actions,"查看档案",()=>UnitDetails(selected),false,true,54);
                if(selected.Status=="ready")U.Button(card,selected.Kind=="crop"?"收获成熟作物":"预约处理成品",()=>Confirm("确认收获",selected.Kind=="crop"?"收获这份成熟的示例作物，加入仓库。":"演示工作人员处理完成后的成品收取，不邮寄活体。",()=>{Act(model.Harvest(selected.Id));Render();}),true,true,54,"gift");
            }
        }
        string UnitName(FarmUnit unit)=>unit.Kind=="crop"?"地块"+(model.Plots.IndexOf(unit)+1)+" · "+unit.Name:unit.Name;
        static string UnitStatus(FarmUnit u)=>u.Status=="empty"?"待种植":u.Status=="ready"?"可以收获":u.Status=="harvested"?"已收取":"生长中 · "+u.Days+"/"+u.Total+"天";
        static string ChinaTime(long ms)=>DateTimeOffset.FromUnixTimeMilliseconds(ms).ToOffset(TimeSpan.FromHours(8)).ToString("MM-dd HH:mm");
        void Segment(Transform row,string text,bool selected,Action action)
        {var b=U.Button(row,text,action,selected,true,52);if(!selected)b.GetComponent<Image>().color=FarmTheme.Paper;}
        void Progress(Transform parent,float amount)
        {var rail=U.Box(parent,FarmTheme.Line,8,4);var fill=U.Box(rail,FarmTheme.Accent,0,4);fill.anchorMin=Vector2.zero;fill.anchorMax=new Vector2(Mathf.Clamp01(amount),1);fill.offsetMin=fill.offsetMax=Vector2.zero;}
        void UnitDetails(FarmUnit unit)
        {
            Modal("种养档案",c=>{U.Photo(c,unit.Art,190);U.Label(c,unit.Name,23,null,true,38);Summary(c,"当前进度",UnitStatus(unit));Summary(c,"预计周期",unit.Total+"天（示例）");Summary(c,"照料规则",unit.Kind=="crop"?"每日2次 / 间隔6小时":"每日2次 / 间隔4小时");Note(c,"该档案用于展示种养操作流程，照片为摄影示意，观测数据不是现场传感器回执。");U.Button(c,"去看农场画面",()=>{CloseImmediate();cameraKey=unit.Kind=="crop"?"farm-estate":"livestock";Navigate("live");});});
        }
        void Shop()
        {
            model.VisitShop(Now);Title("农场商城","选一份时令，也选一份好收成");
            Hero(content,"shop-banner","田园好物","好时令，种好物","从种养认领，到日常照料，一站备齐。",190);
            var tabs=U.Row(content,52,6);Segment(tabs,"当季推荐",shopTab=="adoption",()=>ChangeShop("adoption"));Segment(tabs,"农场物资",shopTab=="supplies",()=>ChangeShop("supplies"));Segment(tabs,"积分好礼",shopTab=="gifts",()=>ChangeShop("gifts"));
            if(shopTab=="adoption")
            {
                int month=DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(8)).Month;
                Note(content,month+"月种养建议 · 结合季节、成熟周期与示例产值排序。农场所在地和真实农时待确认。");
                foreach(var p in model.RankedProducts(month))ProductCard(content,p);
            }
            else
            {
                var sum=model.QuoteCart(false);var row=U.Row(content,52);U.Label(row,"可用 "+model.Points+" 积分",18,null,true);U.Button(row,"购物车 · "+sum.Count,Cart,false,true,52,"shop");
                foreach(var good in model.Goods.Where(g=>shopTab=="gifts"?g.Category=="gifts":g.Category!="gifts"))GoodCard(content,good);
                U.Button(content,"查看购物车",Cart,true,true,54,"shop");
            }
            Note(content,"商城为体验样本：积分兑换不涉及现金，认养示例金额不发起付款。");
        }
        void ChangeShop(string tab){SavePosition();shopTab=tab;Render(false);}
        void ProductCard(Transform parent,FarmProduct p)
        {
            var c=U.Card(parent,10,14);U.Photo(c,p.Art,180);U.Label(c,p.Name,22,null,true,34);
            U.Label(c,(p.Kind=="crop"?"种植":"养殖")+" · 约"+p.Days+"天 · 示例产值 ¥"+p.ValueMin+"–"+p.ValueMax,15,FarmTheme.Secondary,false,44);
            var row=U.Row(c,52);U.Label(row,"¥"+p.Cost+" / 份",23,FarmTheme.Primary,true);var b=U.Button(row,"选择",()=>Adoption(p));U.Width((RectTransform)b.transform,116);
        }
        void Adoption(FarmProduct p)
        {
            FarmUnit chosen=null;Modal("选择种养",c=>
            {
                U.Photo(c,p.Art,160);U.Label(c,p.Name,23,null,true,36);Summary(c,"示例认养金额","¥"+p.Cost+"（不收款）");
                U.Label(c,p.Kind=="crop"?"选择空闲地块":"选择空闲圈舍",18,null,true,32);
                var available=p.Kind=="crop"?model.Plots.Where(u=>u.Status=="empty").ToList():new List<FarmUnit>{new FarmUnit{Id=null,Name="新增示例圈舍"}};
                var buttons=new List<Button>();foreach(var unit in available)
                {var b=U.Button(c,p.Kind=="crop"?UnitName(unit):unit.Name,()=>{chosen=unit;foreach(var x in buttons)x.GetComponent<Image>().color=FarmTheme.Paper;buttons[available.IndexOf(unit)].GetComponent<Image>().color=FarmTheme.Action;},false);buttons.Add(b);}
                if(available.Count==0)Note(c,"暂时没有空闲位置，先回农场查看当前种养进度。");
                Note(c,"选择后加入离线示例农场。真实播种、派工、价格与种养资格需由农场确认。");
                var error=U.Label(c,"",15,FarmTheme.Danger,false,44);
                U.Button(c,"确认选择",()=>{if(chosen==null){error.text="请先选择一个空闲位置";return;}var result=model.Adopt(p.Id,chosen.Id);if(!result.Ok){error.text=result.Message;return;}Act(result);CloseImmediate();farmTab=p.Kind;selectedUnit=p.Kind=="animal"?model.Animals[model.Animals.Count-1].Id:chosen.Id;Navigate("farm");},true,available.Count>0,54);
            });
        }
        void GoodCard(Transform parent,FarmGood good)
        {
            var c=U.Card(parent,8,14);var row=U.Row(c,104,14);var photo=U.Rect("Product picture",row);U.Width(photo,100);U.Photo(photo,good.Art,104);var img=photo.GetChild(0) as RectTransform;U.Fill(img);
            var text=U.VBox(row,5);U.Label(text,good.Name,19,null,true,30);U.Label(text,good.Description,14,FarmTheme.Secondary,false,54);
            var bottom=U.Row(c,52);U.Label(bottom,good.Cost+" 积分",21,FarmTheme.Primary,true);U.Button(bottom,"加入购物车",()=>{Act(model.AddCart(good.Id,1));Render();},true,true,52);
        }
        void Cart()
        {
            bool useCoupon=false;Action render=null;render=()=>Modal("积分购物车",c=>
            {
                if(model.Cart.Count==0){U.Label(c,"还没有选好物资",23,null,true,50);U.Label(c,"去商城挑选照料物资，或攒分兑换田园好礼。",16,FarmTheme.Secondary,false,62);U.Button(c,"去逛商城",()=>{CloseImmediate();shopTab="supplies";Navigate("shop");});return;}
                foreach(var pair in model.Cart.ToList())
                {var g=model.Goods.Find(x=>x.Id==pair.Key);var box=U.Card(c,8,12,FarmTheme.Canvas);U.Label(box,g.Name+" · "+g.Cost+"积分/件",18,null,true,32);var row=U.Row(box,50);U.Button(row,"−",()=>{Act(model.AddCart(g.Id,-1));render();},false);U.Label(row,pair.Value.ToString(),19,null,true,0,TextAnchor.MiddleCenter);U.Button(row,"+",()=>{Act(model.AddCart(g.Id,1));render();},false);}
                var quote=model.QuoteCart(useCoupon);Summary(c,"商品合计",quote.Subtotal+"积分");
                U.Button(c,(useCoupon?"已使用":"使用")+"满60减20积分券",()=>{useCoupon=!useCoupon;render();},false,useCoupon||(model.CouponAvailable&&quote.Subtotal>=60));
                Summary(c,"优惠减免",quote.Discount+"积分");Summary(c,"本次兑换",quote.Total+"积分");Summary(c,"当前余额",model.Points+"积分");
                var error=U.Label(c,"",15,FarmTheme.Danger,false,45);string tx=Guid.NewGuid().ToString("N");
                U.Button(c,"确认兑换",()=>{var result=model.Checkout(useCoupon,tx);if(!result.Ok){error.text=result.Message;return;}Act(result);Render();Modal("兑换完成",d=>{U.Label(d,"好物已收入仓库",25,null,true,50);U.Label(d,"积分已扣除，物资已到账。可以继续照料，也可以回看这笔兑换。",17,FarmTheme.Secondary,false,80);U.Button(d,"查看我的仓库",Warehouse);U.Button(d,"查看兑换记录",Receipts,false);});},true,true,56);
                Note(c,"积分、库存与物资一次结算，余额不足不会扣分。此处不涉及现金付款。");
            });render();
        }
        void Activities()
        {
            Title("活动中心","每日来田园，收下小小好心意",()=>Navigate("home"));
            Hero(content,"activity-banner","田园有礼","耕耘有回响","签到、做农事，攒下每一份小收获。",200);
            var sign=U.Card(content);U.Label(sign,"七日签到",23,null,true,34);U.Label(sign,"当前连续 "+model.SignStreak+" 天 · 每日一次",16,FarmTheme.Secondary,false,29);
            string[] rewards={"20积分","30积分","1饲料","40积分","1肥料","60积分","积分券"};
            for(int i=0;i<7;i+=4){var row=U.Row(sign,74,6);for(int j=i;j<Math.Min(i+4,7);j++){int day=j;U.Button(row,"第"+(j+1)+"天\n"+rewards[j],()=>Info("签到奖励","第"+(day+1)+"天可获得"+rewards[day]+"。按上海日期每日领取一次，连续签到中断后重新开启。"),false,true,74).GetComponentInChildren<Text>().fontSize=14;}}
            U.Button(sign,model.SignedToday(Now)?"今日已签到":"领取今日 · "+model.SignRewardText(Now),()=>{Act(model.ClaimSignIn(Now));Render();},true,!model.SignedToday(Now),54);
            Heading(content,"每日任务");
            TaskCard("browse","逛逛农场商城","挑选当季种养或照料物资",()=>Navigate("shop"));TaskCard("care","完成一次照料","浇水收到回执，或完成一次投喂",()=>Navigate("farm"));TaskCard("harvest","收获一份田园成果","手动收鸡蛋，或收获成熟作物",()=>{farmTab="animal";Navigate("farm");});
            var welcome=U.Card(content);U.Label(welcome,"新人见面礼",21,null,true,32);U.Label(welcome,"30积分 + 2份饲料，本次体验领取一次。",16,FarmTheme.Secondary,false,46);U.Button(welcome,model.WelcomeClaimed?"已领取":"领取新人礼",()=>{Act(model.ClaimWelcome());Render();},true,!model.WelcomeClaimed,54,"gift");
            var ad=U.Card(content);U.Label(ad,"田园补给",21,null,true,32);U.Label(ad,"完整体验模拟广告，领取20积分和1份饲料。每天最多3次。",16,FarmTheme.Secondary,false,62);U.Button(ad,"体验模拟广告",Ad,true,true,54);
            var invite=U.Card(content);U.Label(invite,"邀请好友，一起种养",21,null,true,34);U.Label(invite,"分享合耕小舍体验入口。有效拉新与平台奖励尚未接入，分享不会自动领取奖励。",16,FarmTheme.Secondary,false,80);U.Button(invite,"分享给好友",Share,true,true,54,"friends");
        }
        void TaskCard(string id,string title,string desc,Action go)
        {
            var c=U.Card(content);U.Label(c,title,20,null,true,32);U.Label(c,desc,15,FarmTheme.Secondary,false,44);
            bool claimed=model.TaskClaimed(id,Now),ready=model.TaskReady(id,Now);U.Button(c,claimed?"已领取":ready?"领取积分":"去完成",()=>{if(ready){Act(model.ClaimTask(id,Now));Render();}else go();},!claimed,!claimed,52);
        }
        void Ad()
        {
            adCompleted=false;adSeconds=10;Text countdown=null;Button claim=null;string receipt=Guid.NewGuid().ToString("N");
            Modal("模拟广告体验",c=>{U.Photo(c,"season-banner",190);U.Label(c,"慢慢耕耘，自有收获",24,null,true,40);U.Label(c,"这是离线广告流程演示，没有加载真实广告。中途退出或切到后台不会完成资格。",16,FarmTheme.Secondary,false,80);countdown=U.Label(c,"还需完整体验 10 秒",20,null,true,45,TextAnchor.MiddleCenter);claim=U.Button(c,"体验中…",()=>{if(!adCompleted)return;Act(model.ClaimAd(true,receipt,Now));CloseImmediate();Render();},true,false,56);});
            adRoutine=StartCoroutine(AdCountdown(countdown,claim));
        }
        IEnumerator AdCountdown(Text t,Button b)
        {
            while(adSeconds>0){yield return new WaitForSecondsRealtime(1);if(t==null)yield break;if(paused){t.text="体验已中断，请关闭后重新体验";yield break;}adSeconds--;t.text="还需完整体验 "+adSeconds+" 秒";}
            adCompleted=true;t.text="完整体验已完成";b.interactable=true;b.GetComponentInChildren<Text>().text="领取20积分和1份饲料";
        }
        void Live()
        {
            Title("农场实景","换个视角，看看田园里的日常");
            var tabs=U.Row(content,52);Segment(tabs,"农田",cameraKey=="farm-estate",()=>{cameraKey="farm-estate";Render();});Segment(tabs,"牧场",cameraKey=="livestock",()=>{cameraKey="livestock";Render();});Segment(tabs,"猪第一视角",cameraKey=="pig-pov",()=>{cameraKey="pig-pov";Render();});
            Hero(content,cameraKey,"摄影示意 · 非直播",cameraKey=="pig-pov"?"小猪眼里的农场":cameraKey=="livestock"?"牧场里的慢时光":"田野间的日常",cameraKey=="pig-pov"?"贴近地面的第一视角场景体验。":"静态场景体验，尚未连接真实摄像头。",390);
            var c=U.Card(content);U.Label(c,"把农场装进口袋",23,null,true,35);U.Label(c,"未来可以远程看长势、看牲畜活动，按需进行照料。当前画面为内置摄影风格示意，不是用户农场实拍。",17,FarmTheme.Secondary,false,104);U.Button(c,"回农场照料",()=>Navigate("farm"),true,true,54,"leaf");
        }
        void Profile()
        {
            Title("我的田园","种下一点期待，收获日常的美好");
            var profile=U.Card(content,12,20,FarmTheme.Header);var row=U.Row(profile,62);var avatar=U.Box(row,FarmTheme.Paper,60,30);U.Width(avatar,60);var icon=U.Icon(avatar,"user",FarmTheme.Primary);U.Fill(icon,14,14,14,14);var names=U.VBox(row,3);U.Label(names,"体验农友",24,null,true,35);U.Label(names,"田园等级 Lv."+(1+model.XP/60)+" · "+model.XP+"经验",15,FarmTheme.Secondary,false,27);
            var stats=U.Row(profile,68);Stat(stats,model.Points.ToString(),"可用积分");Stat(stats,model.Feed.ToString(),"照料饲料");Stat(stats,(model.Eggs+model.Crops+model.Meat).ToString(),"累计收获");
            Menu("gift","我的仓库","物资与收获",Warehouse);Menu("shop","兑换记录",model.Receipts.Count+"笔",Receipts);Menu("farm","收获配送","示例收货流程",DeliveryList);Menu("friends","我的农友",friends.Count+"位",()=>Navigate("friends"));Menu("calendar","签到与任务","每日田园好礼",()=>Navigate("activities"));Menu("message","消息中心",messages.Count+"条",Messages);Menu("leaf","种养图鉴","认识当季好物",Collection);Menu("gift","分享合耕小舍","邀请一起体验",Share);Menu("user","关于与体验说明","Unity 安卓体验版",About);
            Note(content,"离线体验版 · 本次进程内保留进度，完全退出后重置。没有登录真实账户，也不会连接设备或产生订单。");
        }
        void Stat(Transform parent,string value,string label){var c=U.VBox(parent,2);U.Label(c,value,26,null,true,34,TextAnchor.MiddleCenter);U.Label(c,label,14,FarmTheme.Secondary,false,23,TextAnchor.MiddleCenter);}
        void Menu(string icon,string title,string summary,Action action)
        {
            var b=U.Button(content,"",action,false,true,66);b.GetComponent<Image>().color=FarmTheme.Paper;var i=U.Icon(b.transform,icon,FarmTheme.Primary);U.Place(i,16,20,25,25);var t=U.Label(b.transform,title,18,null,true);U.Place((RectTransform)t.transform,54,8,180,50);var s=U.Label(b.transform,summary,13,FarmTheme.Secondary,false,0,TextAnchor.MiddleRight);U.Place((RectTransform)s.transform,226,9,126,48);var n=U.Icon(b.transform,"next",FarmTheme.Secondary);U.Place(n,359,25,15,15);
        }
        void Warehouse()
        {
            Modal("我的仓库",c=>{U.Label(c,"照料物资",22,null,true,34);Summary(c,"饲料",model.Feed+"份");Summary(c,"营养肥",model.Fertilizer+"份");Summary(c,"农事工具",model.Tools+"件");Summary(c,"种子包",model.Seeds+"份");Summary(c,"田园装扮",model.Decorations+"件");U.Label(c,"田园收获",22,null,true,34);Summary(c,"鲜鸡蛋",model.Eggs+"枚");Summary(c,"成熟作物",model.Crops+"份");Summary(c,"处理成品",model.Meat+"份");Note(c,"收获来自本次体验中的手动收取。照料物资不会解除次数和冷却限制。");U.Button(c,"体验收获配送",DeliveryList);U.Button(c,"去补充照料物资",()=>{CloseImmediate();shopTab="supplies";Navigate("shop");},false);});
        }
        void Receipts()
        {Modal("兑换记录",c=>{if(model.Receipts.Count==0){U.Label(c,"还没有兑换记录",22,null,true,45);U.Label(c,"在商城兑换后，可在这里核对积分与物资。",16,FarmTheme.Secondary,false,70);}foreach(var r in model.Receipts.AsEnumerable().Reverse()){var box=U.Card(c,7,14,FarmTheme.Canvas);U.Label(box,r.Summary,18,null,true,56);Summary(box,"原价 / 优惠",r.Subtotal+" / −"+r.Discount+"积分");Summary(box,"本次扣除",r.Total+"积分");}});}
        void DeliveryList()
        {
            Modal("收获配送",c=>{U.Label(c,"让田园新鲜，走上餐桌",23,null,true,64);Note(c,"只体验收货填写流程，请使用示例信息。不生成真实运单，不扣除仓库物资。");DeliveryItem(c,"eggs","鲜鸡蛋",model.Eggs);DeliveryItem(c,"crops","成熟作物",model.Crops);DeliveryItem(c,"meat","处理好的畜禽成品",model.Meat);foreach(var d in deliveries)U.Label(c,d,16,FarmTheme.Secondary,false,75);});
        }
        void DeliveryItem(Transform c,string id,string title,int count)
        {var box=U.Card(c,9,14,FarmTheme.Canvas);U.Label(box,title+" · "+count+(id=="eggs"?"枚":"份"),19,null,true,34);U.Button(box,shipping.Contains(id)?"已体验配送":count>0?"填写收货信息":"先去收获",()=>{if(count>0)Shipping(id,title);else{CloseImmediate();SavePosition();farmTab=id=="crops"?"crop":"animal";selectedUnit=id=="eggs"?model.Animals.FirstOrDefault(u=>u.Art=="chicken")?.Id:id=="meat"?model.Animals.FirstOrDefault(u=>u.Status=="ready")?.Id:model.Plots.FirstOrDefault(u=>u.Status=="ready")?.Id;Navigate("farm");}},count>0,!shipping.Contains(id));}
        void Shipping(string id,string title)
        {
            Modal("填写示例收货信息",c=>
            {
                U.Label(c,title,22,null,true,34);Note(c,"请只填写示例资料。原始内容不保存、不联网，确认后仅保留脱敏摘要。");
                var name=U.Field(c,"收件人","例如：体验农友",30);var phone=U.Field(c,"手机号码","例如：13800000000",11,false,InputField.ContentType.IntegerNumber);var address=U.Field(c,"收货地址","例如：示例省示例市田园路1号",160,true);var email=U.Field(c,"邮箱（选填）","例如：hello@example.com",120,false,InputField.ContentType.EmailAddress);
                dirty=()=>name!=null&&(name.text.Length+phone.text.Length+address.text.Length+email.text.Length)>0;
                var error=U.Label(c,"",15,FarmTheme.Danger,false,54);
                U.Button(c,"确认示例收货信息",()=>
                {
                    if(name.text.Trim().Length<2){error.text="请填写至少2个字的示例收件人";name.ActivateInputField();return;}
                    if(!System.Text.RegularExpressions.Regex.IsMatch(phone.text.Trim(),"^1[3-9][0-9]{9}$")){error.text="请填写有效的11位示例手机号";phone.ActivateInputField();return;}
                    if(address.text.Trim().Length<5){error.text="请填写至少5个字的示例收货地址";address.ActivateInputField();return;}
                    if(email.text.Length>0&&!System.Text.RegularExpressions.Regex.IsMatch(email.text.Trim(),"^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")){error.text="请检查示例邮箱格式，或留空";email.ActivateInputField();return;}
                    if(shipping.Add(id)){deliveries.Add(title+" · "+name.text.Trim().Substring(0,1)+"** / "+phone.text.Substring(0,3)+"****"+phone.text.Substring(7)+"\n示例配送待处理 · 详细地址已隐藏");messages.Add("已完成"+title+"的示例配送流程。");}
                    dirty=null;CloseImmediate();Info("示例信息已确认","已保留脱敏摘要。此流程没有发送真实订单或运单，也未扣除仓库物资。");
                },true,true,56);
            });
        }
        void Collection()
        {Modal("种养图鉴",c=>{foreach(var p in model.Products){var row=U.Row(c,86,12);var photo=U.Rect("Picture",row);U.Width(photo,85);U.Photo(photo,p.Art,86);U.Fill((RectTransform)photo.GetChild(0));var labels=U.VBox(row,4);U.Label(labels,p.Name,20,null,true,32);U.Label(labels,(p.Kind=="crop"?"时令作物":"牧场伙伴")+" · 约"+p.Days+"天",15,FarmTheme.Secondary,false,32);}Note(c,"成熟周期和品种仅用于演示，真实农时由农场结合所在地确认。");});}
        void Messages()
        {Modal("消息中心",c=>{if(messages.Count==0){U.Label(c,"还没有新消息",23,null,true,50);U.Label(c,"完成照料、领取福利和兑换后，这里会留下本次体验记录。",17,FarmTheme.Secondary,false,85);}foreach(var m in messages.AsEnumerable().Reverse())Note(c,m);});}
        void About()
        {Modal("关于合耕小舍",c=>{U.Photo(c,"farm-estate",180);U.Label(c,"合耕小舍",28,null,true,44);U.Label(c,"Unity 原生安卓体验版 · 0.1.2",16,FarmTheme.Secondary,false,35);Note(c,"当前为离线体验，不接真实微信账户、设备、直播、广告、付款和物流。全部业务进度及社区内容仅本次进程内保留。");U.Label(c,"照片为生成的摄影风格示意，不是农场实拍。字体 Noto Sans CJK SC 依 SIL OFL 1.1 使用。",16,FarmTheme.Secondary,false,90);U.Button(c,"查看公开H5体验入口",Share,false);U.Button(c,"查看字体许可",()=>Info("字体许可",Resources.Load<TextAsset>("Fonts/NotoSansCJKsc-LICENSE")?.text??"SIL Open Font License 1.1 · Copyright 2014-2021 Adobe"),false);});}
        void Summary(Transform c,string label,string value)
        {var row=U.Row(c,44);U.Label(row,label,16,FarmTheme.Secondary);U.Label(row,value,17,FarmTheme.Ink,true,0,TextAnchor.MiddleRight);}

        void Community()
        {
            Title("田园社区","分享耕耘，也分享生活的小欢喜",()=>Navigate("home"));
            var tabs=U.Row(content,52,5);foreach(var name in new[]{"全部"}.Concat(circles)){string key=name;var b=U.Button(tabs,key,()=>{SavePosition();circle=key;Render(false);},circle==key,true,52);b.GetComponentInChildren<Text>().fontSize=14;}
            if(circle!="全部")
            {var c=U.Card(content);U.Label(c,circle,23,null,true,35);U.Label(c,"和同好交流种养经验，留住田园日常。",16,FarmTheme.Secondary,false,48);var b=U.Button(c,joined.Contains(circle)?"退出圈子":"加入圈子",null,true);b.onClick.AddListener(()=>{if(joined.Contains(circle))joined.Remove(circle);else joined.Add(circle);b.GetComponentInChildren<Text>().text=joined.Contains(circle)?"退出圈子":"加入圈子";Toast(joined.Contains(circle)?"已加入这个示例圈子":"已退出这个示例圈子");});}
            var actions=U.Row(content,54);U.Button(actions,"发动态",Compose,true,true,54,"plus");U.Button(actions,"我的农友",()=>Navigate("friends"),false,true,54,"friends");
            foreach(var p in posts.Where(p=>!hidden.Contains(p.Id)&&(circle=="全部"||p.Circle==circle)))PostCard(content,p);
            U.Label(content,"示例社区 · 互动仅在本次体验内可见",13,FarmTheme.Secondary,false,32,TextAnchor.MiddleCenter);
        }
        void PostCard(Transform parent,Post post)
        {
            var c=U.Card(parent,9,16);var by=U.Row(c,50);var avatar=U.Box(by,FarmTheme.Soft,40,20);U.Width(avatar,40);var icon=U.Icon(avatar,"user",FarmTheme.Primary);U.Fill(icon,9,9,9,9);var names=U.VBox(by,0);U.Label(names,post.Author,17,null,true,23);U.Label(names,post.Circle+" · 示例动态",12,FarmTheme.Secondary,false,19);
            U.Label(c,post.Text,17,null,false,Mathf.Max(56,Mathf.Ceil(post.Text.Length/20f)*26));
            if(!string.IsNullOrEmpty(post.Photo))U.Photo(c,post.Photo,190);
            var row=U.Row(c,49,6);var like=U.Button(row,(liked.Contains(post.Id)?"已点赞 ":"点赞 ")+(post.Likes+(liked.Contains(post.Id)?1:0)),null,false,true,49,"heart");like.onClick.AddListener(()=>{if(!liked.Add(post.Id))liked.Remove(post.Id);like.GetComponentInChildren<Text>().text=(liked.Contains(post.Id)?"已点赞 ":"点赞 ")+(post.Likes+(liked.Contains(post.Id)?1:0));});
            U.Button(row,"评论 "+post.Comments.Count,()=>PostDetail(post),false,true,49,"message");U.Button(row,"分享",Share,false,true,49);
        }
        void PostDetail(Post post)
        {
            Modal("田园动态",c=>
            {
                U.Label(c,post.Author+" · "+post.Circle,18,null,true,34);U.Label(c,post.Text,18,null,false,Mathf.Max(78,Mathf.Ceil(post.Text.Length/19f)*28));if(post.Photo!=null)U.Photo(c,post.Photo,180);
                U.Label(c,"评论 · "+post.Comments.Count,21,null,true,34);foreach(var comment in post.Comments)Note(c,comment);
                var input=U.Field(c,"留下你的想法","聊聊种养经验，或送上一句鼓励…",200,true);dirty=()=>input!=null&&input.text.Length>0;var err=U.Label(c,"",14,FarmTheme.Danger,false,40);
                U.Button(c,"发布评论",()=>{var text=input.text.Trim();if(text.Length<2){err.text="写下至少2个字，再发布评论";return;}if(Input.compositionString.Length>0)return;post.Comments.Add("体验农友："+text);dirty=null;PostDetail(post);Toast("评论已发布，仅本次体验可见");},true,true,54);
                if(post.Mine)U.Button(c,"删除这条动态",()=>Confirm("删除动态","删除后将移除本次体验的动态和评论。",()=>{posts.Remove(post);CloseImmediate();Render();Toast("动态已删除");}),false);
                else U.Button(c,"举报或屏蔽",()=>Confirm("屏蔽此条示例动态","本次体验中不再显示。不会向真实审核人员发送举报。",()=>{hidden.Add(post.Id);CloseImmediate();Render();Toast("已在本次体验中屏蔽");}),false);
            });
        }
        void Compose()
        {
            string chosenPhoto="bokchoy",chosenCircle=circle=="全部"?circles[0]:circle;
            Modal("发动态",c=>
            {
                U.Label(c,"记录你的田园日常",23,null,true,36);U.Label(c,"这一刻的耕耘与收获，值得被看见。",16,FarmTheme.Secondary,false,38);
                var input=U.Field(c,"动态内容","今天的农场有什么新鲜事？聊聊长势、照料或收获…",600,true);dirty=()=>input!=null&&input.text.Length>0;
                U.Label(c,"发布到圈子",16,null,true,28);var row=U.Row(c,51,5);var circleButtons=new List<Button>();
                foreach(var key in circles){string k=key;var b=U.Button(row,k,null,k==chosenCircle,true,51);b.GetComponentInChildren<Text>().fontSize=14;b.onClick.AddListener(()=>{chosenCircle=k;for(int i=0;i<circleButtons.Count;i++)circleButtons[i].GetComponent<Image>().color=circles[i]==k?FarmTheme.Action:FarmTheme.Soft;});circleButtons.Add(b);}
                U.Label(c,"选择一张示意配图",16,null,true,28);var pics=U.Row(c,77,8);foreach(var key in new[]{"bokchoy","carrot","pig"}){string k=key;var b=U.Button(pics,"",null,false,true,77);var p=U.Rect("Photo",b.transform);U.Fill(p,4,4,4,4);U.Photo(p,k,69);U.Fill((RectTransform)p.GetChild(0));b.onClick.AddListener(()=>{chosenPhoto=k;Toast("已选择配图");});}
                var err=U.Label(c,"",15,FarmTheme.Danger,false,42);U.Button(c,"发布动态",()=>{var text=input.text.Trim();if(text.Length<2){err.text="请写下至少2个字的田园日常";input.ActivateInputField();return;}if(Input.compositionString.Length>0)return;posts.Insert(0,new Post{Id=Guid.NewGuid().ToString("N"),Author="体验农友",Text=text,Circle=chosenCircle,Photo=chosenPhoto,Mine=true});dirty=null;CloseImmediate();if(page=="home"||page=="community")Render();else Navigate("community");Toast("动态已发布，仅本次体验可见");},true,true,56);
                U.Label(c,"离线示例社区，不上传内容，不保存到设备。",13,FarmTheme.Secondary,false,37);
            });
        }
        void Friends()
        {
            Title("我的农友","相伴耕耘，分享好收成",()=>Navigate("home"));
            var c=U.Card(content,12,18,FarmTheme.Header);U.Label(c,"有农友的田园，更热闹",22,null,true,36);U.Label(c,"示例好友关系仅保留在本次体验，不访问通讯录。",16,FarmTheme.Secondary,false,55);var r=U.Row(c,52);U.Button(r,"添加农友",AddFriend,true,true,52,"plus");U.Button(r,"分享邀请",Share,false,true,52,"friends");
            Heading(content,"我的农友 · "+friends.Count);
            for(int i=0;i<friendNames.Length;i++)
            {
                int index=i;string id="f"+(i+1);var box=U.Card(content);var row=U.Row(box,52);U.Label(row,friendNames[i],20,null,true);U.Label(row,"示例农友",13,FarmTheme.Secondary,false,0,TextAnchor.MiddleRight);
                U.Label(box,i==0?"种菜交流 · 喜欢分享菜地日常":i==1?"丰收分享 · 期待这一季好收成":"牧场日记 · 关心每一份成长",15,FarmTheme.Secondary,false,44);
                var buttons=U.Row(box,52);U.Button(buttons,"看看田园",()=>FriendDetail(index),false);U.Button(buttons,friends.Contains(id)?"已是农友":requested.Contains(id)?"取消申请":"加为农友",()=>{if(friends.Contains(id)){FriendDetail(index);return;}if(!requested.Add(id))requested.Remove(id);Render();Toast(requested.Contains(id)?"已发出示例申请":"已取消示例申请");},true);
            }
            var request=U.Card(content);U.Label(request,"新的农友申请",21,null,true,34);U.Label(request,friends.Contains("f2")?"你已和老周成为示例农友。":"老周的菜园想和你成为农友（示例）。",16,FarmTheme.Secondary,false,52);U.Button(request,friends.Contains("f2")?"已接受":"接受申请",()=>{friends.Add("f2");requested.Remove("f2");Render();Toast("已成为示例农友");},true,!friends.Contains("f2"));
        }
        void AddFriend()
        {Modal("添加农友",c=>{U.Label(c,"输入农友码，找到田园同好",21,null,true,62);var input=U.Field(c,"农友码","例如：HG1003",12);dirty=()=>input!=null&&input.text.Length>0;var err=U.Label(c,"",15,FarmTheme.Danger,false,50);U.Button(c,"查找农友",()=>{if(input.text.Trim().ToUpperInvariant()!="HG1003"){err.text="体验版请使用示例农友码 HG1003";return;}dirty=null;CloseImmediate();FriendDetail(2);});Note(c,"此处为离线查找演示，不使用真实身份或通讯录。");});}
        void FriendDetail(int index)
        {string id="f"+(index+1);Modal("农友的田园",c=>{U.Photo(c,index==2?"livestock":"farm-estate",210);U.Label(c,friendNames[index],25,null,true,42);U.Label(c,"示例农友 · 只展示公开田园示意",16,FarmTheme.Secondary,false,50);U.Button(c,friends.Contains(id)?"移除农友":requested.Contains(id)?"取消申请":"加为农友",()=>{if(friends.Contains(id)){Confirm("移除农友","仅移除本次体验的示例关系。",()=>{friends.Remove(id);FriendDetail(index);Render();Toast("已移除示例农友");});}else{if(!requested.Add(id))requested.Remove(id);FriendDetail(index);Render();}},!friends.Contains(id));Note(c,"农友关系不授予照料对方地块或操作设备的权限。");});}

        string DeviceLabel()=>model.DeviceStatus=="sending"?"等待启动回执":model.DeviceStatus=="running"?"灌溉中":model.DeviceStatus=="stopping"?"等待停止回执":model.DeviceStatus=="unknown"?"结果未确认":"待机";
        void Device(string id)
        {
            Modal("灌溉设备 · 演示",c=>
            {
                var unit=model.Plots.Find(u=>u.Id==id);U.Label(c,(unit!=null?UnitName(unit):"当前地块")+" · "+DeviceLabel(),23,null,true,64);
                Note(c,"当前使用离线模拟设备。收到启动回执后才计入照料；离开面板不等于停止设备。");
                U.Label(c,"确认对象 → 发送 → 启动回执 → 执行 → 停止回执",16,FarmTheme.Secondary,false,70);
                if(model.DeviceStatus=="idle")
                {
                    U.Label(c,"模拟回执场景",17,null,true,30);var options=U.Row(c,52,6);var selectors=new List<Button>();string[] modes={"normal","noack","offline"},labels={"正常回执","无回执","设备离线"};
                    for(int i=0;i<3;i++){int j=i;var b=U.Button(options,labels[i],null,deviceScenario==modes[i],true);b.GetComponentInChildren<Text>().fontSize=14;b.onClick.AddListener(()=>{deviceScenario=modes[j];for(int k=0;k<3;k++)selectors[k].GetComponent<Image>().color=deviceScenario==modes[k]?FarmTheme.Action:FarmTheme.Soft;});selectors.Add(b);}
                    var error=U.Label(c,"",15,FarmTheme.Danger,false,52);U.Button(c,"确认地块，启动演示灌溉",()=>{if(deviceScenario=="offline"){error.text="模拟设备离线，未发送灌溉请求";return;}var result=model.BeginWater(id,Now);if(!result.Ok){error.text=result.Message;return;}deviceBusy=true;Device(id);StartCoroutine(WaterSequence(id,deviceScenario=="noack",model.DeviceGeneration));},true,true,56,"water");
                }
                else if(model.DeviceStatus=="unknown")
                {U.Label(c,"未收到回执，不表示设备已经停止。请先核查，不自动重发。",17,FarmTheme.Warning,false,92);U.Button(c,"核查模拟设备状态",()=>{Act(model.ReconcileWater());deviceBusy=false;Device(id);Render();},true,true,54);}
                else
                {U.Label(c,DeviceLabel()+"…",25,FarmTheme.Primary,true,80,TextAnchor.MiddleCenter);if(model.DeviceStatus=="running")U.Button(c,"请求停止演示灌溉",()=>{if(model.DeviceStatus!="running")return;Act(model.RequestStopWater());Device(id);},false);}
                U.Button(c,"返回农场",()=>{CloseImmediate();Navigate("farm");Render();},false,true,52);
            });
        }
        IEnumerator WaterSequence(string id,bool missing,int generation)
        {
            yield return new WaitForSecondsRealtime(1);
            if(generation!=model.DeviceGeneration)yield break;
            if(missing){Act(model.MarkWaterUnknown());deviceBusy=false;RefreshDevice(id);yield break;}
            var result=model.AcknowledgeWater(Now,generation);Act(result);RefreshDevice(id);
            yield return new WaitForSecondsRealtime(3);
            if(generation!=model.DeviceGeneration)yield break;
            if(model.DeviceStatus=="running")model.RequestStopWater();RefreshDevice(id);
            yield return new WaitForSecondsRealtime(1);if(generation!=model.DeviceGeneration)yield break;Act(model.ConfirmStopWater(generation));deviceBusy=false;RefreshDevice(id);
        }
        void RefreshDevice(string id){Render();if(modalRoot!=null&&modalRoot.name=="灌溉设备 · 演示")Device(id);}
        void Act(FarmResult result){UpdateBalance();Toast(result.Message);if(result.Ok){messages.Add(result.Message);if(messages.Count>80)messages.RemoveAt(0);}}
        void Modal(string title,Action<RectTransform> builder)
        {
            CloseImmediate();SetPageInteractable(false);modalRoot=U.Rect(title,safe);U.Fill(modalRoot);U.Surface(modalRoot,new Color(.08f,.09f,.07f,.52f),0);
            modalPanel=U.Rect("Sheet",modalRoot);modalPanel.anchorMin=new Vector2(.025f,.045f);modalPanel.anchorMax=new Vector2(.975f,.955f);modalPanel.offsetMin=modalPanel.offsetMax=Vector2.zero;U.Surface(modalPanel,FarmTheme.Paper,20);
            var h=U.Rect("Dialog title",modalPanel);h.anchorMin=new Vector2(0,1);h.anchorMax=Vector2.one;h.pivot=new Vector2(.5f,1);h.sizeDelta=new Vector2(0,70);var text=U.Label(h,title,23,null,true);U.Fill((RectTransform)text.transform,20,7,67,7);
            var close=U.IconButton(h,"close",()=>TryClose());U.Place((RectTransform)close.transform,340,11,48,48);
            var b=U.Rect("Dialog scroll",modalPanel);U.Fill(b,0,70,0,12);U.Scroll(b,out modalContent,18);builder(modalContent);U.Spacer(modalContent,14);Canvas.ForceUpdateCanvases();
            var select=modalContent.GetComponentsInChildren<Button>().FirstOrDefault(x=>x.interactable);if(select!=null)EventSystem.current?.SetSelectedGameObject(select.gameObject);
        }
        void TryClose(Action then=null)
        {
            if(confirmLayer!=null)return;
            if(dirty!=null&&dirty())
            {
                var r=U.Rect("Discard draft",modalRoot);U.Fill(r);U.Surface(r,new Color(.1f,.1f,.07f,.6f),0);confirmLayer=r.gameObject;
                var original=modalPanel.GetComponent<CanvasGroup>();if(original==null)original=modalPanel.gameObject.AddComponent<CanvasGroup>();original.interactable=false;original.blocksRaycasts=false;
                var box=U.Card(r,12,20);box.anchorMin=new Vector2(.05f,.27f);box.anchorMax=new Vector2(.95f,.73f);box.offsetMin=box.offsetMax=Vector2.zero;
                U.Label(box,"放弃未提交内容？",23,null,true,48);U.Label(box,"关闭后会清空本次填写的内容。",17,FarmTheme.Secondary,false,68);var keep=U.Button(box,"继续填写",()=>{Destroy(confirmLayer);confirmLayer=null;original.interactable=true;original.blocksRaycasts=true;var field=modalPanel.GetComponentInChildren<InputField>();if(field!=null)EventSystem.current.SetSelectedGameObject(field.gameObject);},true);U.Button(box,"放弃并关闭",()=>{dirty=null;CloseImmediate();then?.Invoke();},false);EventSystem.current.SetSelectedGameObject(keep.gameObject);return;
            }
            CloseImmediate();then?.Invoke();
        }
        void CloseImmediate()
        {
            dirty=null;if(adRoutine!=null){StopCoroutine(adRoutine);adRoutine=null;adCompleted=false;}
            if(modalRoot!=null){modalRoot.gameObject.SetActive(false);Destroy(modalRoot.gameObject);}modalRoot=modalPanel=modalContent=null;confirmLayer=null;SetPageInteractable(true);
        }
        void SetPageInteractable(bool enabled)
        {foreach(var r in new[]{header,body,footer})if(r!=null){var group=r.GetComponent<CanvasGroup>();if(group==null)group=r.gameObject.AddComponent<CanvasGroup>();group.interactable=enabled;group.blocksRaycasts=enabled;}}
        void Confirm(string title,string message,Action action)
        {
            // Reuse the modal owner, retaining an existing draft under the confirmation.
            if(modalRoot!=null&&dirty!=null&&dirty()){TryClose(()=>Confirm(title,message,action));return;}
            Modal(title,c=>{U.Label(c,message,18,FarmTheme.Secondary,false,120);U.Button(c,"返回",()=>TryClose(),false);U.Button(c,title,()=>{CloseImmediate();action();},true,true,56);});
        }
        void Info(string title,string message){Modal(title,c=>{U.Label(c,message,17,FarmTheme.Secondary,false,Mathf.Max(120,Mathf.Ceil(message.Length/20f)*25));U.Button(c,"知道了",()=>TryClose());});}
        void Toast(string message)
        {
            if(toastRoutine!=null)StopCoroutine(toastRoutine);
            if(toastRoot==null){toastRoot=U.Box(safe,FarmTheme.Ink,0,12);toastRoot.anchorMin=toastRoot.anchorMax=new Vector2(.5f,0);toastRoot.pivot=new Vector2(.5f,0);toastRoot.anchoredPosition=new Vector2(0,96);toastRoot.sizeDelta=new Vector2(382,76);toastRoot.GetComponent<Image>().raycastTarget=false;toastLabel=U.Label(toastRoot,"",16,Color.white,false,0,TextAnchor.MiddleCenter);U.Fill((RectTransform)toastLabel.transform,14,6,14,6);}
            toastRoot.SetAsLastSibling();toastRoot.gameObject.SetActive(true);toastLabel.text=message;toastRoutine=StartCoroutine(HideToast());
        }
        IEnumerator HideToast(){yield return new WaitForSecondsRealtime(3.1f);if(toastRoot!=null)toastRoot.gameObject.SetActive(false);}
        void Share()
        {
            Modal("分享合耕小舍",c=>
            {
                U.Photo(c,"farm-estate",170);U.Label(c,"和农友，一起收获田园时光",23,null,true,66);U.Label(c,"分享公开H5体验入口，不包含你的动态、草稿或收货资料。分享不等于有效拉新。",16,FarmTheme.Secondary,false,83);
                var link=U.Field(c,"公开体验链接",ShareUrl,200);link.text=ShareUrl;link.readOnly=true;
                U.Button(c,"系统分享",SystemShare,true,true,54,"friends");U.Button(c,"复制体验链接",()=>{GUIUtility.systemCopyBuffer=ShareUrl;Toast("已复制公开体验链接");},false);
            });
        }
        void SystemShare()
        {
            #if UNITY_ANDROID && !UNITY_EDITOR
            try
            {using(var cls=new AndroidJavaClass("com.unity3d.player.UnityPlayer"))using(var activity=cls.GetStatic<AndroidJavaObject>("currentActivity"))using(var intent=new AndroidJavaObject("android.content.Intent")){intent.Call<AndroidJavaObject>("setAction","android.intent.action.SEND");intent.Call<AndroidJavaObject>("setType","text/plain");intent.Call<AndroidJavaObject>("putExtra","android.intent.extra.TEXT","合耕小舍 · 一起收获田园时光\n"+ShareUrl);using(var chooser=new AndroidJavaClass("android.content.Intent"))using(var choice=chooser.CallStatic<AndroidJavaObject>("createChooser",intent,"分享合耕小舍")){activity.Call("startActivity",choice);}}}
            catch{Toast("系统分享暂不可用，可以复制链接");}
            #else
            GUIUtility.systemCopyBuffer=ShareUrl;Toast("已复制公开体验链接");
            #endif
        }
        void OnApplicationPause(bool value)
        {
            paused=value;
            if(value&&model!=null&&model.DeviceStatus!="idle"&&model.DeviceStatus!="unknown"){model.MarkWaterUnknown();deviceBusy=false;}
            if(value&&adRoutine!=null){StopCoroutine(adRoutine);adRoutine=null;adCompleted=false;Info("体验已中断","切换到后台未完成广告资格。可以关闭面板后重新体验。");}
            if(!value&&model!=null&&content!=null){Render();if(modalRoot!=null&&modalRoot.name=="灌溉设备 · 演示")Device(model.DeviceUnitId);}
        }
        void Update()
        {
            if(Input.GetKeyDown(KeyCode.Escape)){if(modalRoot!=null)TryClose();else if(page!="home")Navigate("home");else Confirm("退出体验","本次离线进度将重置。",()=>Application.Quit());}
            if(modalPanel!=null)
            {
                float kb=TouchScreenKeyboard.visible?TouchScreenKeyboard.area.height/Mathf.Max(.01f,canvas.scaleFactor):0;
                modalPanel.offsetMin=new Vector2(0,kb>0?Mathf.Min(kb,safe.rect.height*.45f):0);
            }
        }
    }
}
