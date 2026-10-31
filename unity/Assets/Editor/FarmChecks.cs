using System;
using System.Collections.Generic;
using System.Linq;

namespace Hegeng
{
    // Every case runs an independent real model. No scene, network or player data is touched.
    public static class FarmChecks
    {
        public const int ExpectedCount=43;
        static long At(string value) { return DateTimeOffset.Parse(value,System.Globalization.CultureInfo.InvariantCulture).ToUnixTimeMilliseconds(); }
        static readonly long T=At("2026-10-31T04:00:00Z");
        static void Need(bool value,string message) { if(!value)throw new Exception(message); }
        static void OK(FarmResult r) { Need(r.Ok,r.Message); }
        static void No(FarmResult r) { Need(!r.Ok,"operation unexpectedly succeeded"); }
        static FarmModel New() { return new FarmModel(T); }
        public static void RunAll()
        {
            int count=0; var failures=new List<string>();
            Action<string,Action> test=(name,body)=>{count++;try{body();}catch(Exception e){failures.Add(name+": "+e.Message);}};
            test("seed farm offers both care and mature harvest",()=>{var m=New();Need(m.Plots.Count==6&&m.Animals.Count==3,"farm objects absent");Need(m.Points==80&&m.Feed==6,"wallet differs");Need(m.Products.Count==9&&m.Goods.Count==8,"catalog absent");});
            test("feed spends shared inventory and earns confirmed care",()=>{var m=New();OK(m.FeedAnimal("P01",T));Need(m.Feed==5&&m.XP==128&&m.TaskReady("care",T),"feed event not atomic");});
            test("feed cannot repeat before four hours",()=>{var m=New();OK(m.FeedAnimal("P01",T));No(m.FeedAnimal("P01",T+4*3600000-1));Need(m.Feed==5,"cooldown spent feed");});
            test("feed permits exact four hour boundary",()=>{var m=New();OK(m.FeedAnimal("P01",T));OK(m.FeedAnimal("P01",T+4*3600000));Need(m.Feed==4,"second feed missing");});
            test("third daily care remains blocked after cooldown",()=>{var m=New();OK(m.FeedAnimal("P01",T));OK(m.FeedAnimal("P01",T+4*3600000));No(m.FeedAnimal("P01",T+8*3600000));Need(m.Feed==4,"daily limit spent feed");});
            test("empty feed inventory fails without progress",()=>{var m=New();m.Feed=0;No(m.FeedAnimal("P01",T));Need(m.XP==120&&!m.TaskReady("care",T),"empty feed credited care");});
            test("mature crops cannot be watered",()=>{var m=New();No(m.BeginWater("A02",T));Need(m.DeviceStatus=="idle","ready crop locked device");});
            test("wet crop cannot be watered",()=>{var m=New();m.Plots.Find(x=>x.Id=="A01").Moisture=65;No(m.BeginWater("A01",T));});
            test("water send reserves use but does not credit success",()=>{var m=New();OK(m.BeginWater("A01",T));Need(m.DeviceStatus=="sending"&&m.XP==120&&!m.TaskReady("care",T)&&m.Plots[0].Moisture==32,"send pretended success");});
            test("one device prevents a second concurrent start",()=>{var m=New();OK(m.BeginWater("A01",T));No(m.BeginWater("A03",T));Need(m.DeviceUnitId=="A01","device target changed");});
            test("water acknowledgement credits once",()=>{var m=New();OK(m.BeginWater("A01",T));OK(m.AcknowledgeWater(T+2000));No(m.AcknowledgeWater(T+3000));Need(m.XP==128&&m.TaskReady("care",T+3000),"duplicate or missing acknowledgement");});
            test("stop request does not claim stopped or moisten crop",()=>{var m=New();OK(m.BeginWater("A01",T));OK(m.AcknowledgeWater(T));OK(m.RequestStopWater());Need(m.DeviceStatus=="stopping"&&m.Plots[0].Moisture==32,"stop request pretended ACK");});
            test("stop confirmation changes moisture once",()=>{var m=New();OK(m.BeginWater("A01",T));OK(m.AcknowledgeWater(T));OK(m.RequestStopWater());OK(m.ConfirmStopWater());No(m.ConfirmStopWater());Need(m.DeviceStatus=="idle"&&m.Plots[0].Moisture==40,"stop confirmation duplicated");});
            test("unacknowledged device stays locked and uncredited",()=>{var m=New();OK(m.BeginWater("A01",T));OK(m.MarkWaterUnknown());No(m.AcknowledgeWater(T));No(m.BeginWater("A03",T));Need(m.XP==120&&m.Plots[0].Moisture==32,"unknown device credited success");});
            test("manual reconciliation preserves six hour reservation",()=>{var m=New();OK(m.BeginWater("A01",T));OK(m.MarkWaterUnknown());OK(m.ReconcileWater());No(m.BeginWater("A01",T+6*3600000-1));OK(m.BeginWater("A01",T+6*3600000));});
            test("stopping unknown cannot be automatically confirmed",()=>{var m=New();OK(m.BeginWater("A01",T));OK(m.AcknowledgeWater(T));OK(m.RequestStopWater());OK(m.MarkWaterUnknown());No(m.ConfirmStopWater());Need(m.Plots[0].Moisture==32,"unknown stop updated moisture");});
            test("Shanghai midnight resets count without bypassing interval",()=>{long a=At("2026-10-31T15:30:00Z"),b=At("2026-10-31T16:01:00Z");var m=new FarmModel(a);OK(m.FeedAnimal("P01",a));No(m.FeedAnimal("P01",b));Need(m.CareStatus("P01",b).Remaining==2,"UTC was used as day boundary");OK(m.FeedAnimal("P01",a+4*3600000));});
            test("past Shanghai day cannot grant rewards",()=>{var m=New();OK(m.ClaimSignIn(T));No(m.ClaimSignIn(T-86400000));Need(m.Points==100,"past date credited reward");});
            test("unknown goods cannot enter cart",()=>{var m=New();No(m.AddCart("not-goods",1,T));Need(m.Cart.Count==0,"unknown SKU entered cart");});
            test("negative quantity cannot create inventory",()=>{var m=New();No(m.AddCart("feed-pack",-1,T));Need(m.Cart.Count==0,"negative cart accepted");});
            test("daily stock includes prior purchases",()=>{var m=New();m.Points=1000;OK(m.AddCart("feed-pack",5,T));OK(m.Checkout(false,"stock-one",T));No(m.AddCart("feed-pack",1,T));Need(m.Feed==21,"stock failure granted feed");});
            test("insufficient balance preserves cart coupon stock and wallet",()=>{var m=New();OK(m.AddCart("harvest-frame",1,T));No(m.Checkout(false,"poor",T));Need(m.Points==80&&m.Cart["harvest-frame"]==1&&m.CouponAvailable&&m.Receipts.Count==0&&m.Decorations==0,"failed checkout mutated assets");});
            test("full sixty coupon quotes twenty discount",()=>{var m=New();OK(m.AddCart("feed-pack",2,T));var q=m.QuoteCart(true);Need(q.Subtotal==60&&q.Discount==20&&q.Total==40&&q.Count==2,"coupon quote wrong");});
            test("below threshold coupon fails without consuming anything",()=>{var m=New();OK(m.AddCart("feed-pack",1,T));No(m.Checkout(true,"low-coupon",T));Need(m.Points==80&&m.Feed==6&&m.CouponAvailable&&m.Cart.Count==1,"invalid coupon mutated resources");});
            test("checkout commits wallet inventory coupon and receipt together",()=>{var m=New();OK(m.AddCart("feed-pack",2,T));OK(m.Checkout(true,"purchase-one",T));Need(m.Points==40&&m.Feed==12&&!m.CouponAvailable&&m.Cart.Count==0&&m.Receipts.Count==1&&m.Receipts[0].Total==40,"purchase partial commit");});
            test("replayed transaction never debits or clears later cart",()=>{var m=New();OK(m.AddCart("feed-pack",1,T));OK(m.Checkout(false,"same-key",T));OK(m.AddCart("fertilizer",1,T));OK(m.Checkout(true,"same-key",T));Need(m.Points==50&&m.Feed==9&&m.Fertilizer==2&&m.Cart["fertilizer"]==1&&m.Receipts.Count==1,"transaction replay mutated current state");});
            test("empty checkout creates no receipt",()=>{var m=New();No(m.Checkout(false,"empty",T));Need(m.Points==80&&m.Receipts.Count==0,"empty purchase recorded");});
            test("invalid transaction key does not debit",()=>{var m=New();OK(m.AddCart("feed-pack",1,T));No(m.Checkout(false,"",T));Need(m.Points==80&&m.Cart.Count==1,"invalid key debited");});
            test("same day signin grants once",()=>{var m=New();OK(m.ClaimSignIn(T));No(m.ClaimSignIn(T));Need(m.Points==100&&m.XP==130&&m.SignStreak==1&&m.SignedToday(T),"signin duplicated");});
            test("seven day signin follows points feed fertilizer coupon sequence",()=>{var m=New();for(int i=0;i<7;i++)OK(m.ClaimSignIn(T+i*86400000L));Need(m.Points==230&&m.Feed==7&&m.Fertilizer==3&&m.SignStreak==7,"seven day sequence wrong");});
            test("missed signin restarts first day reward",()=>{var m=New();OK(m.ClaimSignIn(T));OK(m.ClaimSignIn(T+2*86400000L));Need(m.Points==120&&m.SignStreak==1,"streak ignored skipped date");});
            test("task must complete before reward",()=>{var m=New();No(m.ClaimTask("care",T));Need(m.Points==80,"unearned task rewarded");});
            test("shop task ready on visit and pays once",()=>{var m=New();OK(m.VisitShop(T));OK(m.VisitShop(T));OK(m.ClaimTask("browse",T));No(m.ClaimTask("browse",T));Need(m.Points==90&&m.XP==128&&m.TaskClaimed("browse",T),"browse task duplicated");});
            test("collect eggs moves stock once and earns harvest task",()=>{var m=New();OK(m.CollectEggs(T));No(m.CollectEggs(T));Need(m.Eggs==3&&m.EggsAvailable==0&&m.XP==128&&m.TaskReady("harvest",T),"egg collection duplicated");});
            test("mature harvest clears crop and cannot repeat",()=>{var m=New();OK(m.Harvest("A02",T));No(m.Harvest("A02",T));Need(m.Crops==1&&m.Plots.Find(x=>x.Id=="A02").Status=="empty"&&m.XP==128,"crop harvest duplicated");});
            test("growing crop cannot be harvested",()=>{var m=New();No(m.Harvest("A01",T));Need(m.Crops==0&&m.XP==120,"unripe crop harvested");});
            test("adoption cannot replace occupied plot or spend points",()=>{var m=New();No(m.Adopt("radish","A01",T));OK(m.Adopt("radish","A04",T));No(m.Adopt("lettuce","A04",T));Need(m.Points==80&&m.Plots.Find(x=>x.Id=="A04").Art=="radish","adoption replaced occupied plot or charged money");});
            test("welcome reward pays once",()=>{var m=New();OK(m.ClaimWelcome(T));No(m.ClaimWelcome(T));Need(m.Points==110&&m.Feed==8,"welcome repeated");});
            test("incomplete ad cannot grant and original receipt remains usable",()=>{var m=New();No(m.ClaimAd(false,"ad-one",T));OK(m.ClaimAd(true,"ad-one",T));No(m.ClaimAd(true,"ad-one",T));Need(m.Points==100&&m.Feed==7,"ad completion or dedup broken");});
            test("fourth ad is capped and next Shanghai day reopens",()=>{var m=New();for(int i=0;i<3;i++)OK(m.ClaimAd(true,"ad-"+i,T));No(m.ClaimAd(true,"ad-four",T));OK(m.ClaimAd(true,"ad-four",T+86400000));Need(m.Points==160,"ad cap or day reset wrong");});
            test("autumn recommendation precedes faster out of season product",()=>{var m=New();var p=m.RankedProducts(10,"crop");Need(p.Count==6&&p[0].Id=="radish"&&p[p.Count-1].Id=="tomato"&&p[0].Recommended,"season priority missing");});
            test("welfare and shopping do not clear care cooldown",()=>{var m=New();OK(m.FeedAnimal("P01",T));OK(m.ClaimWelcome(T));OK(m.AddCart("feed-pack",1,T));OK(m.Checkout(false,"extra-feed",T));No(m.FeedAnimal("P01",T+1000));Need(m.Feed==10,"welfare bypassed cooldown");});
            test("new crop cycle does not reset the same plot daily care limit",()=>{var m=New();OK(m.BeginWater("A01",T));OK(m.AcknowledgeWater(T));OK(m.RequestStopWater());OK(m.ConfirmStopWater());m.Plots[0].Status="ready";OK(m.Harvest("A01",T));OK(m.Adopt("lettuce","A01",T));No(m.BeginWater("A01",T+1000));Need(m.CareStatus("A01",T+1000).Remaining==1,"replanting reset plot care allowance");});
            if(count!=ExpectedCount)throw new Exception("FarmChecks count differs: "+count);
            if(failures.Count>0)throw new Exception("FARM_CHECKS_FAIL "+failures.Count+"/"+count+"\n"+string.Join("\n",failures.ToArray()));
            Console.WriteLine("FARM_CHECKS_PASS "+count);
        }
#if FARM_CHECKS_STANDALONE
        public static int Main() { try { RunAll();return 0; }catch(Exception e){Console.WriteLine(e.Message);return 1;} }
#endif
    }
}
