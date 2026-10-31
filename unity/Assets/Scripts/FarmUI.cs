using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.EventSystems;

namespace Hegeng
{
    // Shared UGUI primitives. Coordinates and type sizes use a 432-point mobile canvas.
    public static class FarmUI
    {
        public static Font Font;
        static readonly Dictionary<int, Sprite> Shapes = new Dictionary<int, Sprite>();
        public static RectTransform Rect(string name, Transform parent)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            return (RectTransform)go.transform;
        }
        public static void Fill(RectTransform r, float left=0, float top=0, float right=0, float bottom=0)
        {
            r.anchorMin=Vector2.zero; r.anchorMax=Vector2.one;
            r.offsetMin=new Vector2(left,bottom); r.offsetMax=new Vector2(-right,-top);
        }
        public static void Place(RectTransform r,float x,float y,float w,float h)
        {
            r.anchorMin=r.anchorMax=new Vector2(0,1);r.pivot=new Vector2(0,1);
            r.anchoredPosition=new Vector2(x,-y);r.sizeDelta=new Vector2(w,h);
        }
        public static void Height(RectTransform r,float h)
        {
            var le=r.gameObject.GetComponent<LayoutElement>();if(le==null)le=r.gameObject.AddComponent<LayoutElement>();
            le.minHeight=h;le.preferredHeight=h;le.flexibleHeight=0;
        }
        public static void Width(RectTransform r,float w)
        {
            var le=r.gameObject.GetComponent<LayoutElement>();if(le==null)le=r.gameObject.AddComponent<LayoutElement>();
            le.minWidth=w;le.preferredWidth=w;le.flexibleWidth=0;
        }
        public static Sprite Rounded(int radius=16)
        {
            if(Shapes.TryGetValue(radius,out var sprite))return sprite;
            int size=radius*2+4;var texture=new Texture2D(size,size,TextureFormat.RGBA32,false);
            texture.name="UI rounded "+radius;texture.filterMode=FilterMode.Bilinear;
            for(int y=0;y<size;y++)for(int x=0;x<size;x++)
            {
                float dx=Mathf.Max(radius-x,0,x-(size-radius-1));
                float dy=Mathf.Max(radius-y,0,y-(size-radius-1));
                float a=Mathf.Clamp01(radius+0.5f-Mathf.Sqrt(dx*dx+dy*dy));
                texture.SetPixel(x,y,new Color(1,1,1,a));
            }
            texture.Apply();
            sprite=Sprite.Create(texture,new Rect(0,0,size,size),new Vector2(.5f,.5f),100,0,SpriteMeshType.FullRect,new Vector4(radius,radius,radius,radius));
            Shapes[radius]=sprite;return sprite;
        }
        public static Image Surface(RectTransform r,Color color,int radius=16)
        {
            var image=r.gameObject.GetComponent<Image>();if(image==null)image=r.gameObject.AddComponent<Image>();image.color=color;
            if(radius>0){image.sprite=Rounded(radius);image.type=Image.Type.Sliced;}
            return image;
        }
        public static RectTransform Box(Transform parent,Color color,float height=0,int radius=16)
        {
            var r=Rect("Surface",parent);Surface(r,color,radius);if(height>0)Height(r,height);Flexible(r);return r;
        }
        static void Flexible(RectTransform r)
        {var element=r.GetComponent<LayoutElement>();if(element==null)element=r.gameObject.AddComponent<LayoutElement>();element.flexibleWidth=1;}
        public static RectTransform VBox(Transform parent,float gap=12,int padding=0)
        {
            var r=Rect("Column",parent);var layout=r.gameObject.AddComponent<VerticalLayoutGroup>();
            layout.spacing=gap;layout.padding=new RectOffset(padding,padding,padding,padding);
            layout.childControlWidth=true;layout.childControlHeight=true;
            layout.childForceExpandWidth=true;layout.childForceExpandHeight=false;
            Flexible(r);return r;
        }
        public static RectTransform Row(Transform parent,float height=52,float gap=8)
        {
            var r=Rect("Row",parent);var element=r.gameObject.AddComponent<LayoutElement>();
            // Reserve the baseline height, but let child font metrics and wrapped text grow the row.
            element.minHeight=height;element.flexibleHeight=0;
            var g=r.gameObject.AddComponent<HorizontalLayoutGroup>();g.spacing=gap;
            g.childControlHeight=true;g.childControlWidth=true;g.childForceExpandWidth=false;g.childForceExpandHeight=true;
            return r;
        }
        public static Text Label(Transform parent,string text,int size=17,Color? color=null,bool bold=false,float height=0,TextAnchor alignment=TextAnchor.MiddleLeft)
        {
            var r=Rect("Text",parent);var label=r.gameObject.AddComponent<Text>();
            label.font=Font;label.text=text;label.fontSize=size;label.color=color??FarmTheme.Ink;
            label.fontStyle=bold?FontStyle.Bold:FontStyle.Normal;label.alignment=alignment;
            label.supportRichText=false;label.horizontalOverflow=HorizontalWrapMode.Wrap;
            label.verticalOverflow=VerticalWrapMode.Truncate;label.raycastTarget=false;
            label.lineSpacing=1.15f;
            // Height is a minimum. Let Text's actual wrapped/newline layout own its preferred height.
            if(height>0){var element=r.gameObject.AddComponent<LayoutElement>();element.minHeight=height;element.flexibleHeight=0;}
            Flexible(r);return label;
        }
        public static RectTransform Card(Transform parent,float gap=10,int padding=18,Color? color=null)
        {
            var c=VBox(parent,gap,padding);Surface(c,color??FarmTheme.Paper);return c;
        }
        public static Button Button(Transform parent,string text,Action click,bool primary=true,bool enabled=true,float height=52,string icon=null)
        {
            var r=Rect(text,parent);Height(r,height);Flexible(r);
            var image=Surface(r,primary?FarmTheme.Action:FarmTheme.Soft,12);
            var button=r.gameObject.AddComponent<Button>();button.targetGraphic=image;
            var colors=button.colors;colors.normalColor=Color.white;colors.highlightedColor=new Color(.98f,.95f,.85f);
            colors.pressedColor=new Color(.88f,.83f,.69f);colors.selectedColor=new Color(.93f,.89f,.77f);
            colors.disabledColor=new Color(.88f,.87f,.83f,1);colors.fadeDuration=.08f;button.colors=colors;
            button.interactable=enabled;
            var label=Label(r,text,17,enabled?FarmTheme.Ink:FarmTheme.Secondary,true,0,TextAnchor.MiddleCenter);
            Fill((RectTransform)label.transform,icon==null?10:36,2,10,2);
            if(icon!=null){var i=Icon(r,icon,FarmTheme.Ink);Place(i,12,(height-23)/2,23,23);}
            if(click!=null)button.onClick.AddListener(()=>click());return button;
        }
        public static Button IconButton(Transform parent,string icon,Action click,Color? bg=null)
        {
            var b=Button(parent,"",click,false,true,48);Width((RectTransform)b.transform,48);
            b.GetComponent<Image>().color=bg??FarmTheme.Canvas;
            var i=Icon(b.transform,icon,FarmTheme.Ink);Fill(i,12,12,12,12);return b;
        }
        public static RectTransform Icon(Transform parent,string kind,Color color)
        {
            var r=Rect(kind,parent);var g=r.gameObject.AddComponent<FarmIcon>();g.Kind=kind;g.color=color;g.raycastTarget=false;return r;
        }
        public static Image Photo(Transform parent,string key,float height=180)
        {
            var r=Rect("Photo "+key,parent);Height(r,height);var image=r.gameObject.AddComponent<Image>();
            image.sprite=Resources.Load<Sprite>("Photos/"+key);image.color=Color.white;image.preserveAspect=false;image.raycastTarget=false;
            // Aspect-preserving cover, with reserved geometry before loading.
            var mask=r.gameObject.AddComponent<RectMask2D>();
            var frame=Rect("Cover",r);Fill(frame);var cover=frame.gameObject.AddComponent<Image>();cover.sprite=image.sprite;cover.raycastTarget=false;
            image.enabled=false;
            var fitter=frame.gameObject.AddComponent<AspectRatioFitter>();fitter.aspectMode=AspectRatioFitter.AspectMode.EnvelopeParent;
            fitter.aspectRatio=image.sprite==null?1:(float)image.sprite.texture.width/image.sprite.texture.height;
            return cover;
        }
        public static ScrollRect Scroll(Transform parent,out RectTransform content,float padding=18)
        {
            var r=Rect("Scroll",parent);Fill(r);var scroll=r.gameObject.AddComponent<ScrollRect>();
            var viewport=Rect("Viewport",r);Fill(viewport);viewport.gameObject.AddComponent<RectMask2D>();
            var hit=Surface(viewport,new Color(1,1,1,.001f),0);
            content=VBox(viewport,14,(int)padding);content.anchorMin=new Vector2(0,1);content.anchorMax=new Vector2(1,1);content.pivot=new Vector2(.5f,1);content.sizeDelta=Vector2.zero;
            var fit=content.gameObject.AddComponent<ContentSizeFitter>();fit.verticalFit=ContentSizeFitter.FitMode.PreferredSize;
            scroll.viewport=viewport;scroll.content=content;scroll.horizontal=false;scroll.movementType=ScrollRect.MovementType.Clamped;scroll.scrollSensitivity=32;
            var rail=Rect("Scroll bar",r);rail.anchorMin=new Vector2(1,0);rail.anchorMax=new Vector2(1,1);rail.pivot=new Vector2(1,.5f);rail.sizeDelta=new Vector2(4,0);rail.offsetMin=new Vector2(-4,5);rail.offsetMax=new Vector2(0,-5);
            var bar=rail.gameObject.AddComponent<Scrollbar>();var handle=Rect("Thumb",rail);Fill(handle);bar.handleRect=handle;bar.targetGraphic=Surface(handle,FarmTheme.ScrollThumb,2);bar.direction=Scrollbar.Direction.BottomToTop;
            scroll.verticalScrollbar=bar;scroll.verticalScrollbarVisibility=ScrollRect.ScrollbarVisibility.AutoHide;return scroll;
        }
        public static InputField Field(Transform parent,string label,string placeholder,int limit=80,bool multiline=false,InputField.ContentType type=InputField.ContentType.Standard)
        {
            var c=VBox(parent,7);Label(c,label,16,null,true,24);
            var r=Rect(label+" input",c);Height(r,multiline?126:54);Surface(r,FarmTheme.Canvas,10);
            var input=r.gameObject.AddComponent<FarmInputField>();input.characterLimit=limit;input.contentType=type;
            input.lineType=multiline?InputField.LineType.MultiLineNewline:InputField.LineType.SingleLine;
            var t=Label(r,"",17,FarmTheme.Ink);Fill((RectTransform)t.transform,13,12,13,12);t.alignment=multiline?TextAnchor.UpperLeft:TextAnchor.MiddleLeft;
            var p=Label(r,placeholder,16,FarmTheme.Muted);Fill((RectTransform)p.transform,13,12,13,12);p.alignment=t.alignment;
            input.textComponent=t;input.placeholder=p;input.selectionColor=new Color(.85f,.70f,.25f,.3f);
            return input;
        }
        public static void Spacer(Transform parent,float h=6){Height(Rect("Space",parent),h);}
        public static void Clear(Transform parent)
        {
            for(int i=parent.childCount-1;i>=0;i--){var go=parent.GetChild(i).gameObject;go.SetActive(false);UnityEngine.Object.Destroy(go);}
        }
    }

    // Dismissing the mobile keyboard ends editing; discarding a form belongs to its explicit dialog.
    public sealed class FarmInputField : InputField
    {
        bool dispatching;

        protected override void LateUpdate() { PreserveDraft(() => base.LateUpdate()); }
        public override void OnUpdateSelected(BaseEventData eventData) { PreserveDraft(() => base.OnUpdateSelected(eventData)); }
        public override void OnDeselect(BaseEventData eventData)
        {
            PreserveDraft(() => base.OnDeselect(eventData));
        }
        protected override void OnDisable() { PreserveDraft(() => base.OnDisable()); }

        void PreserveDraft(Action update)
        {
            if(dispatching||!isFocused){update();return;}
            // Both native keyboard status and Escape can call non-virtual DeactivateInputField.
            // Keep each live edit, but ignore its canceled rollback after isFocused becomes false.
            string latest=text;bool didEnd=false;
            var changed=onValueChanged;var ended=onEndEdit;var values=new List<string>();
            var liveChanges=new OnChangeEvent();var editEnd=new EndEditEvent();
            liveChanges.AddListener(value=>
            {
                // A value read from an already canceled keyboard is not a new user edit,
                // even if UGUI has not marked wasCanceled yet.
                bool keyboardCanceled=touchScreenKeyboard!=null&&touchScreenKeyboard.status==TouchScreenKeyboard.Status.Canceled;
                if(!keyboardCanceled&&(isFocused||!wasCanceled)){latest=value;values.Add(value);}
            });
            editEnd.AddListener(value=>{if(wasCanceled)SetTextWithoutNotify(latest);didEnd=true;});
            dispatching=true;onValueChanged=liveChanges;onEndEdit=editEnd;
            try{update();}
            finally{onValueChanged=changed;onEndEdit=ended;dispatching=false;}
            // Restore the public events before notifying consumers so listener changes and
            // callbacks that open/close a dialog keep their normal ownership.
            foreach(string value in values)changed?.Invoke(value);
            if(didEnd)ended?.Invoke(text);
        }
    }

    [RequireComponent(typeof(CanvasRenderer))]
    public sealed class FarmIcon : MaskableGraphic
    {
        public string Kind;
        VertexHelper mesh;
        Vector2 P(float x,float y){var r=rectTransform.rect;return new Vector2(r.x+x*r.width,r.y+(1-y)*r.height);}
        void Line(float x,float y,float a,float b,float width=.075f)
        {
            var p=P(x,y);var q=P(a,b);var n=(q-p).normalized;var v=new Vector2(-n.y,n.x)*rectTransform.rect.width*width*.5f;
            int i=mesh.currentVertCount;mesh.AddVert(p+v,color,Vector2.zero);mesh.AddVert(p-v,color,Vector2.zero);mesh.AddVert(q-v,color,Vector2.zero);mesh.AddVert(q+v,color,Vector2.zero);mesh.AddTriangle(i,i+1,i+2);mesh.AddTriangle(i,i+2,i+3);
        }
        void Path(params float[] xy){for(int i=0;i<xy.Length-2;i+=2)Line(xy[i],xy[i+1],xy[i+2],xy[i+3]);}
        void Circle(float x,float y,float radius){for(int i=0;i<32;i++){float a=i*Mathf.PI/16,b=(i+1)*Mathf.PI/16;Line(x+Mathf.Cos(a)*radius,y+Mathf.Sin(a)*radius,x+Mathf.Cos(b)*radius,y+Mathf.Sin(b)*radius,.065f);}}
        protected override void OnPopulateMesh(VertexHelper vh)
        {
            mesh=vh;mesh.Clear();
            switch(Kind)
            {
                case "farm":Path(.12f,.88f,.12f,.42f,.5f,.13f,.88f,.42f,.88f,.88f,.12f,.88f);Path(.4f,.88f,.4f,.6f,.6f,.6f,.6f,.88f);break;
                case "shop":Path(.12f,.4f,.2f,.16f,.8f,.16f,.88f,.4f,.12f,.4f);Path(.18f,.42f,.18f,.88f,.82f,.88f,.82f,.42f);Path(.4f,.88f,.4f,.62f,.6f,.62f,.6f,.88f);Line(.36f,.18f,.33f,.4f);Line(.65f,.18f,.68f,.4f);break;
                case "home":Path(.15f,.47f,.5f,.14f,.85f,.47f);Path(.23f,.4f,.23f,.86f,.77f,.86f,.77f,.4f);Path(.42f,.86f,.42f,.61f,.58f,.61f,.58f,.86f);break;
                case "camera":Path(.12f,.28f,.65f,.28f,.65f,.78f,.12f,.78f,.12f,.28f);Path(.65f,.44f,.9f,.3f,.9f,.76f,.65f,.63f);break;
                case "user":Circle(.5f,.3f,.18f);Path(.13f,.88f,.18f,.67f,.35f,.57f,.65f,.57f,.82f,.67f,.87f,.88f);break;
                case "friends":Circle(.38f,.3f,.16f);Circle(.73f,.38f,.13f);Path(.08f,.86f,.14f,.64f,.32f,.56f,.51f,.58f,.66f,.74f,.67f,.88f);Path(.66f,.61f,.84f,.66f,.93f,.87f);break;
                case "heart":Path(.5f,.87f,.12f,.49f,.1f,.31f,.23f,.16f,.38f,.17f,.5f,.3f,.62f,.17f,.77f,.16f,.9f,.31f,.88f,.49f,.5f,.87f);break;
                case "water":Path(.5f,.09f,.17f,.58f,.17f,.74f,.3f,.9f,.5f,.94f,.7f,.9f,.83f,.74f,.83f,.58f,.5f,.09f);Line(.32f,.65f,.4f,.79f);break;
                case "leaf":Path(.2f,.78f,.16f,.47f,.31f,.22f,.84f,.13f,.8f,.61f,.57f,.82f,.2f,.78f);Line(.16f,.9f,.65f,.35f);break;
                case "gift":Path(.12f,.4f,.88f,.4f,.88f,.57f,.12f,.57f,.12f,.4f);Path(.2f,.57f,.2f,.9f,.8f,.9f,.8f,.57f);Line(.5f,.4f,.5f,.9f);Path(.5f,.4f,.23f,.32f,.23f,.16f,.37f,.14f,.5f,.4f,.64f,.14f,.78f,.16f,.78f,.32f,.5f,.4f);break;
                case "calendar":Path(.14f,.24f,.86f,.24f,.86f,.88f,.14f,.88f,.14f,.24f);Line(.14f,.43f,.86f,.43f);Line(.32f,.12f,.32f,.34f);Line(.68f,.12f,.68f,.34f);Path(.31f,.65f,.45f,.78f,.7f,.54f);break;
                case "check":Path(.18f,.5f,.4f,.74f,.83f,.24f);break;
                case "close":Line(.25f,.25f,.75f,.75f);Line(.25f,.75f,.75f,.25f);break;
                case "back":Path(.65f,.17f,.32f,.5f,.65f,.83f);break;
                case "next":Path(.35f,.17f,.68f,.5f,.35f,.83f);break;
                case "plus":Line(.5f,.16f,.5f,.84f);Line(.16f,.5f,.84f,.5f);break;
                case "message":Path(.12f,.18f,.88f,.18f,.88f,.74f,.42f,.74f,.23f,.9f,.23f,.74f,.12f,.74f,.12f,.18f);Line(.28f,.38f,.72f,.38f);Line(.28f,.56f,.59f,.56f);break;
                default:Circle(.5f,.5f,.33f);Line(.5f,.45f,.5f,.72f);Line(.5f,.25f,.5f,.31f);break;
            }
        }
    }
}
