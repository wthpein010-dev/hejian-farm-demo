using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.Rendering;
using UnityEngine.UI;

// Editor evidence only: never an Android screenshot or a device acceptance test.
[InitializeOnLoad]
public static class FarmPreview
{
    const string Prefix = "Hegeng.FarmPreview.";
    const int Width = 432, Height = 900;
    static readonly string[] Pages = { "home", "farm", "shop", "live", "profile", "community", "activities" };
    static readonly string[] Cases = { "coupon-can-be-removed-below-threshold", "pause-marks-water-unknown",
        "draft-confirmation-isolates-and-focuses", "multiline-post-fits-card-and-detail", "animal-adoption-selects-new-unit",
        "egg-delivery-shortcut-renders-pasture", "meat-delivery-shortcut-selects-pasture",
        "title-row-fits-large-font-and-multiple-lines", "keyboard-cancel-retains-text-and-draft-state",
        "keyboard-escape-retains-text-and-draft-state" };
    static readonly BindingFlags Instance = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

    static FarmPreview() { if (SessionState.GetBool(Prefix + "active", false)) Bind(); }

    public static void Run()
    {
        try
        {
            string output = Environment.GetEnvironmentVariable("HEGENG_UNITY_PREVIEW_OUTPUT");
            Need(!string.IsNullOrWhiteSpace(output) && Path.IsPathRooted(output), "Explicit absolute HEGENG_UNITY_PREVIEW_OUTPUT is required.");
            output = Path.GetFullPath(output);
            Need(output.TrimEnd(Path.DirectorySeparatorChar).Length > 3, "The preview output cannot be a drive root.");
            Need(!Directory.Exists(output) || !Directory.EnumerateFileSystemEntries(output).Any(), "Use a new empty preview output directory.");
            Directory.CreateDirectory(output);
            SessionState.SetString(Prefix + "output", output);
            SessionState.SetString(Prefix + "pages", ""); SessionState.SetString(Prefix + "cases", "");
            SessionState.SetString(Prefix + "errors", ""); SessionState.SetInt(Prefix + "failures", 0);
            SessionState.SetInt(Prefix + "page", 0); SessionState.SetInt(Prefix + "case", 0);
            SessionState.SetBool(Prefix + "active", true); SetTime("started", DateTime.UtcNow);
            SessionState.SetString(Prefix + "stage", "boot"); Bind();
            Need(!EditorApplication.isPlayingOrWillChangePlaymode, "Preview must start in EditMode.");
            Need(SystemInfo.graphicsDeviceType != GraphicsDeviceType.Null, "A graphics device is required; omit -nographics.");
            Type build = FindType("FarmBuild");
            build.GetMethod("ConfigurePhotos", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, null);
            Type view = typeof(EditorWindow).Assembly.GetType("UnityEditor.GameView", true);
            EditorWindow.GetWindow(view, false, "Farm Preview", false);
            PlayModeWindow.SetViewType(PlayModeWindow.PlayModeViewTypes.GameView);
            PlayModeWindow.SetCustomRenderingResolution(Width, Height, "Hegeng Preview 432x900");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            EditorApplication.isPlaying = true;
        }
        catch (Exception error) { Fatal(error); }
    }

    static void Bind()
    {
        EditorApplication.update -= Tick; EditorApplication.update += Tick;
        Application.logMessageReceived -= OnLog; Application.logMessageReceived += OnLog;
    }

    static void OnLog(string message, string stack, LogType type)
    {
        if (!SessionState.GetBool(Prefix + "active", false)) return;
        bool missingFont = message.IndexOf("font", StringComparison.OrdinalIgnoreCase) >= 0 &&
            (message.IndexOf("missing", StringComparison.OrdinalIgnoreCase) >= 0 || message.IndexOf("not found", StringComparison.OrdinalIgnoreCase) >= 0);
        if (type != LogType.Exception && type != LogType.Error && type != LogType.Assert && !missingFont) return;
        if (SessionState.GetInt(Prefix + "failures", 0) < 100)
            Append("errors", "{\"type\":" + Quote(type.ToString()) + ",\"message\":" + Quote(message.Length > 600 ? message.Substring(0, 600) : message) + "}");
        Failed();
    }

    static void Tick()
    {
        if (!SessionState.GetBool(Prefix + "active", false)) return;
        try
        {
            if ((DateTime.UtcNow - Time("started")).TotalSeconds > 180) throw new TimeoutException("Editor UI preview exceeded 180 seconds.");
            string stage = SessionState.GetString(Prefix + "stage", "boot");
            if (stage == "leaving")
            {
                if (!EditorApplication.isPlayingOrWillChangePlaymode) Finish();
                return;
            }
            EditorApplication.QueuePlayerLoopUpdate();
            if (!EditorApplication.isPlaying) return;
            MonoBehaviour app = FindApp();
            if (app == null) return;
            if (stage == "boot")
            {
                Need(Get(app, "canvas") is Canvas, "FarmApp did not create its Canvas/font.");
                SessionState.SetString(Prefix + "stage", "navigate"); return;
            }
            if (stage == "navigate")
            {
                int index = SessionState.GetInt(Prefix + "page", 0);
                if (index == Pages.Length) { SessionState.SetString(Prefix + "stage", "regressions"); return; }
                Call(app, "CloseImmediate"); Call(app, "Navigate", Pages[index]);
                SessionState.SetString(Prefix + "stage", "settle"); SetTime("ready", DateTime.UtcNow.AddSeconds(.75)); return;
            }
            if (stage == "settle")
            {
                if (DateTime.UtcNow < Time("ready")) return;
                ForceLayout(app);
                int index = SessionState.GetInt(Prefix + "page", 0);
                string candidate = Path.Combine(Output, (index + 1).ToString("00") + "-" + Pages[index] + "-gameview.png");
                SessionState.SetString(Prefix + "candidate", candidate);
                ScreenCapture.CaptureScreenshot(candidate, 1);
                SessionState.SetString(Prefix + "stage", "capture"); SetTime("ready", DateTime.UtcNow.AddSeconds(2)); return;
            }
            if (stage == "capture")
            {
                string candidate = SessionState.GetString(Prefix + "candidate", "");
                bool valid = IsNonblankImage(candidate, out string nativeReason);
                if (!valid && DateTime.UtcNow < Time("ready")) return;
                int index = SessionState.GetInt(Prefix + "page", 0);
                string image = candidate, method = "gameview-screencapture-editor";
                string result = null;
                if (valid) result = Inspect(app, null);
                else
                {
                    image = Path.Combine(Output, (index + 1).ToString("00") + "-" + Pages[index] + "-camera.png");
                    method = "camera-rendertexture-editor";
                    CaptureCamera(app, image, camera => result = Inspect(app, camera));
                    Need(IsNonblankImage(image, out string fallbackReason), "Camera preview is blank: " + fallbackReason);
                }
                Append("pages", "{\"page\":" + Quote(Pages[index]) + ",\"screenshot\":" + Quote(Path.GetFileName(image)) +
                    ",\"method\":" + Quote(method) + ",\"nativeFallbackReason\":" + Quote(valid ? "" : nativeReason) + ",\"inspection\":" + result + "}");
                SessionState.SetInt(Prefix + "page", index + 1); SessionState.SetString(Prefix + "stage", "navigate"); return;
            }
            if (stage == "regressions")
            {
                int index = SessionState.GetInt(Prefix + "case", 0);
                if (index == Cases.Length)
                {
                    SessionState.SetString(Prefix + "stage", "leaving"); EditorApplication.isPlaying = false; return;
                }
                RunRegression(app, index);
                SessionState.SetInt(Prefix + "case", index + 1);
            }
        }
        catch (Exception error) { Fatal(error); }
    }

    static void RunRegression(MonoBehaviour app, int index)
    {
        string error = ""; string screenshot = "case-" + (index + 1).ToString("00") + ".png";
        try
        {
            Reset(app);
            object model = Get(app, "model");
            if (index == 0)
            {
                ((IDictionary)Get(model, "Cart"))["feed-pack"] = 2; Call(app, "Cart");
                Click(app, "使用满60减20积分券"); Click(app, "−");
                Button coupon = ModalButtons(app).FirstOrDefault(b => ButtonText(b).Contains("满60减20积分券"));
                Need(coupon != null && (coupon.interactable || ButtonText(coupon).StartsWith("使用", StringComparison.Ordinal)),
                    "Coupon remained selected and disabled after cart fell below 60 points.");
            }
            else if (index == 1)
            {
                object first = ((IList)Get(model, "Plots"))[0];
                object begun = Call(model, "BeginWater", Get(first, "Id"), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                Need((bool)Get(begun, "Ok"), "Water test precondition failed.");
                Call(app, "OnApplicationPause", true);
                Need((string)Get(model, "DeviceStatus") == "unknown", "Pausing during send left device status " + Get(model, "DeviceStatus") + ".");
            }
            else if (index == 2)
            {
                Call(app, "Compose");
                RectTransform panel = (RectTransform)Get(app, "modalPanel");
                ((RectTransform)Get(app, "modalContent")).GetComponentInChildren<InputField>().text = "未提交草稿";
                Call(app, "TryClose", new object[] { null });
                var confirmation = (GameObject)Get(app, "confirmLayer");
                var group = panel.GetComponent<CanvasGroup>();
                GameObject selected = EventSystem.current == null ? null : EventSystem.current.currentSelectedGameObject;
                bool isolated = group != null && !group.interactable;
                bool focused = confirmation != null && selected != null && selected.transform.IsChildOf(confirmation.transform) && selected.GetComponentInParent<Button>() != null;
                Need(isolated && focused, "Draft confirmation: underlying panel isolated=" + isolated + "; confirmation button focused=" + focused + ".");
            }
            else if (index == 3)
            {
                Type postType = app.GetType().GetNestedType("Post", BindingFlags.NonPublic);
                object post = Activator.CreateInstance(postType, true);
                string text = string.Concat(Enumerable.Repeat("两字\n", 10));
                Set(post, "Id", "preview-multiline"); Set(post, "Author", "合成验收"); Set(post, "Circle", "种菜交流"); Set(post, "Text", text);
                var content = (RectTransform)Get(app, "content"); Call(app, "PostCard", content, post); ForceLayout(app);
                Text card = content.GetComponentsInChildren<Text>().First(t => t.text == text);
                bool cardFits = card.rectTransform.rect.height + .5f >= card.preferredHeight;
                float cardHeight = card.rectTransform.rect.height, preferred = card.preferredHeight;
                Call(app, "PostDetail", post); ForceLayout(app);
                Text detail = ((RectTransform)Get(app, "modalContent")).GetComponentsInChildren<Text>().First(t => t.text == text);
                Need(cardFits && detail.rectTransform.rect.height + .5f >= detail.preferredHeight,
                    "Multiline card " + cardHeight + "/" + preferred + "; detail " + detail.rectTransform.rect.height + "/" + detail.preferredHeight + " actual/preferred height.");
            }
            else if (index == 4)
            {
                IList animals = (IList)Get(model, "Animals"); int before = animals.Count;
                object product = ((IEnumerable)Get(model, "Products")).Cast<object>().First(p => (string)Get(p, "Kind") == "animal");
                Call(app, "Adoption", product); Click(app, "新增示例圈舍"); Click(app, "确认选择");
                Need(animals.Count == before + 1, "Animal adoption did not add a synthetic unit.");
                string expected = (string)Get(animals[animals.Count - 1], "Id");
                Need((string)Get(app, "selectedUnit") == expected, "Animal adoption selectedUnit is not the newly added unit ID.");
            }
            else if (index == 5)
            {
                Call(app, "Navigate", "farm"); Call(app, "Warehouse"); Call(app, "DeliveryList");
                ModalButtons(app).First(b => ButtonText(b) == "先去收获").onClick.Invoke(); ForceLayout(app);
                Need(((RectTransform)Get(app, "content")).GetComponentsInChildren<Text>().Any(t => t.text == "今天的鲜鸡蛋"),
                    "Egg shortcut changed farmTab without rendering the pasture page.");
            }
            else if (index == 6)
            {
                Call(app, "Navigate", "profile"); Call(app, "DeliveryList");
                ModalButtons(app).Where(b => ButtonText(b) == "先去收获").ElementAt(2).onClick.Invoke();
                Need((string)Get(app, "farmTab") == "animal", "Meat delivery shortcut selected farmTab=" + Get(app, "farmTab") + ".");
            }
            else if (index == 7)
            {
                Call(app, "Navigate", "shop");
                Text title = ((RectTransform)Get(app, "content")).GetComponentsInChildren<Text>().First(t => t.text == "农场商城");
                // Android font metrics can exceed the nominal 40-point title row even for one line.
                // Two explicit lines at a larger size reproduce that pressure in the Editor as well.
                title.fontSize = 48; title.text = "农场商城\n字体行高回归"; ForceLayout(app);
                var row = (RectTransform)title.transform.parent;
                Need(title.preferredHeight > 40, "Title regression did not exceed the nominal row height.");
                Need(row.rect.height + .5f >= title.preferredHeight && title.rectTransform.rect.height + .5f >= title.preferredHeight &&
                    title.cachedTextGenerator.lineCount == 2,
                    "Large multiline title: row " + row.rect.height + "; text " + title.rectTransform.rect.height + "/" + title.preferredHeight +
                    " actual/preferred height; generated lines " + title.cachedTextGenerator.lineCount + ".");
            }
            else if (index == 8 || index == 9)
            {
                Call(app, "Compose");
                InputField input = ((RectTransform)Get(app, "modalContent")).GetComponentInChildren<InputField>();
                foreach (string[] values in new[] { new[] { "已有内容", "已有内容" }, new[] { "", "drafttwo" }, new[] { "已有内容", "" } })
                {
                    VerifyCanceledEdit(input, values[0], values[1], index == 9);
                    Need(((Func<bool>)Get(app, "dirty"))() == (values[1].Length > 0), "Canceled keyboard changed the form's draft check.");
                }
                VerifyCanceledEdit(input, "", "需要保留的草稿", index == 9);
                Call(app, "TryClose", new object[] { null });
                Need(Get(app, "confirmLayer") is GameObject confirmation && confirmation.activeInHierarchy,
                    "Closing the form after keyboard cancellation skipped the discard confirmation.");
                Need(input.text == "需要保留的草稿", "Opening the discard confirmation changed the draft.");
            }
        }
        catch (Exception failure) { error = Unwrap(failure).Message; Failed(); }
        try { ForceLayout(app); CaptureCamera(app, Path.Combine(Output, screenshot), null); }
        catch (Exception captureError) { error += " Screenshot: " + Unwrap(captureError).Message; Failed(); }
        Append("cases", "{\"name\":" + Quote(Cases[index]) + ",\"passed\":" + (error.Length == 0 ? "true" : "false") +
            ",\"error\":" + Quote(error) + ",\"screenshot\":" + Quote(screenshot) + "}");
        Call(app, "OnApplicationPause", false);
    }

    static void VerifyCanceledEdit(InputField input, string original, string edited, bool escape)
    {
        // Cover both UGUI paths: native-keyboard cancellation reaches OnDeselect, while an
        // Escape key in OnUpdateSelected calls non-virtual DeactivateInputField directly.
        input.SetTextWithoutNotify(original);
        typeof(InputField).GetField("m_OriginalText", Instance).SetValue(input, original);
        typeof(InputField).GetField("m_AllowInput", Instance).SetValue(input, true);
        typeof(InputField).GetField("m_WasCanceled", Instance).SetValue(input, false);
        input.caretPosition = original.Length;
        var changes = new List<string>(); var ended = new List<string>();
        var expectedChanges = new List<string>();
        UnityEngine.Events.UnityAction<string> changed = value => changes.Add(value), end = value => ended.Add(value);
        input.onValueChanged.AddListener(changed); input.onEndEdit.AddListener(end);
        try
        {
            if (escape)
            {
                if (original != edited && original.Length == 0)
                    for (int i = 0; i < edited.Length; i++)
                    { QueueInput(new Event { type = EventType.KeyDown, character = edited[i] }); expectedChanges.Add(edited.Substring(0, i + 1)); }
                else if (original != edited && edited.Length == 0)
                    for (int i = original.Length - 1; i >= 0; i--)
                    { QueueInput(new Event { type = EventType.KeyDown, keyCode = KeyCode.Backspace }); expectedChanges.Add(original.Substring(0, i)); }
                QueueInput(new Event { type = EventType.KeyDown, keyCode = KeyCode.Escape });
                input.OnUpdateSelected(new BaseEventData(EventSystem.current));
            }
            else
            {
                input.text = edited;
                if (original != edited) expectedChanges.Add(edited);
                typeof(InputField).GetField("m_WasCanceled", Instance).SetValue(input, true);
                input.OnDeselect(null);
            }
            input.OnDeselect(null); // A repeated deselection must not erase an already retained edit.
            Need(!input.isFocused && input.text == edited, "Keyboard cancel lost the latest text (including an intentional empty edit).");
            Need(changes.SequenceEqual(expectedChanges), "Keyboard cancel emitted rollback changes or lost live typing/deletion changes.");
            Need(ended.Count == 1 && ended[0] == edited, "Keyboard cancel did not report exactly one end edit with the latest text.");
        }
        finally { input.onValueChanged.RemoveListener(changed); input.onEndEdit.RemoveListener(end); }
    }

    static void QueueInput(Event value) => typeof(Event).GetMethod("QueueEvent", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { value });

    static void Reset(MonoBehaviour app)
    {
        app.StopAllCoroutines(); Call(app, "CloseImmediate");
        Type model = Get(app, "model").GetType();
        Set(app, "model", Activator.CreateInstance(model, new object[] { DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }));
        ((IDictionary)Get(app, "positions")).Clear(); Set(app, "page", "home"); Set(app, "farmTab", "crop");
        Set(app, "paused", false); Set(app, "deviceBusy", false); Call(app, "Render", false); ForceLayout(app);
    }

    static void Click(MonoBehaviour app, string label)
    {
        Button button = ModalButtons(app).FirstOrDefault(b => ButtonText(b) == label);
        Need(button != null && button.interactable, "Expected enabled modal button: " + label);
        button.onClick.Invoke(); ForceLayout(app);
    }
    static Button[] ModalButtons(MonoBehaviour app) => ((RectTransform)Get(app, "modalContent")).GetComponentsInChildren<Button>();
    static string ButtonText(Button button) => string.Join(" ", button.GetComponentsInChildren<Text>().Select(t => t.text).Where(t => !string.IsNullOrWhiteSpace(t)).ToArray());

    static string Inspect(MonoBehaviour app, Camera camera)
    {
        ForceLayout(app); var issues = new List<string>();
        var viewport = new Rect(0, 0, Width, Height); int visibleText = 0, visibleButtons = 0;
        foreach (Text text in app.GetComponentsInChildren<Text>())
        {
            if (!text.enabled || string.IsNullOrWhiteSpace(text.text) || !Visible(text.rectTransform, camera, viewport)) continue;
            visibleText++;
            if (text.verticalOverflow == VerticalWrapMode.Truncate && text.rectTransform.rect.height + .75f < text.preferredHeight)
                issues.Add("Text frame clips content: " + (text.text.Length > 60 ? text.text.Substring(0, 60) : text.text) +
                    " (" + Number(text.rectTransform.rect.height) + "/" + Number(text.preferredHeight) + " actual/preferred height).");
            if (text.font == null) issues.Add("Missing font on visible text.");
            else foreach (char c in text.text.Distinct())
                if (!char.IsWhiteSpace(c) && !char.IsControl(c) && !text.font.HasCharacter(c)) { issues.Add("Missing font glyph U+" + ((int)c).ToString("X4")); break; }
        }
        foreach (Button button in app.GetComponentsInChildren<Button>())
        {
            if (!button.enabled || !Visible((RectTransform)button.transform, camera, viewport)) continue;
            visibleButtons++;
            Rect bounds = ScreenRect((RectTransform)button.transform, camera);
            if (bounds.width < 47.5f || bounds.height < 47.5f)
                issues.Add("Button below 48px: " + ButtonText(button) + " (" + bounds.width.ToString("F1") + "x" + bounds.height.ToString("F1") + ").");
        }
        foreach (Image image in app.GetComponentsInChildren<Image>())
            if (image.enabled && image.name == "Cover" && image.sprite == null) issues.Add("Missing canonical photo sprite.");
        var content = (RectTransform)Get(app, "content");
        if (visibleText < 5 || content.childCount < 2 || content.rect.height < 30 || content.rect.width < 100) issues.Add("Page layout/content is empty.");
        foreach (string issue in issues) Failed();
        return "{\"visibleText\":" + visibleText + ",\"visibleButtons\":" + visibleButtons +
            ",\"contentWidth\":" + Number(content.rect.width) + ",\"contentHeight\":" + Number(content.rect.height) +
            ",\"issues\":[" + string.Join(",", issues.Select(Quote).ToArray()) + "]}";
    }

    static bool Visible(RectTransform rect, Camera camera, Rect viewport)
    {
        if (!rect.gameObject.activeInHierarchy) return false;
        Rect bounds = ScreenRect(rect, camera);
        if (!Intersect(ref bounds, viewport)) return false;
        foreach (RectMask2D mask in rect.GetComponentsInParent<RectMask2D>())
            if (mask.enabled && !Intersect(ref bounds, ScreenRect(mask.rectTransform, camera))) return false;
        foreach (Mask mask in rect.GetComponentsInParent<Mask>())
            if (mask.enabled && !Intersect(ref bounds, ScreenRect(mask.rectTransform, camera))) return false;
        foreach (CanvasGroup group in rect.GetComponentsInParent<CanvasGroup>()) if (group.alpha < .01f) return false;
        return bounds.width > 2 && bounds.height > 2;
    }
    static bool Intersect(ref Rect value, Rect clip)
    {
        value = Rect.MinMaxRect(Mathf.Max(value.xMin, clip.xMin), Mathf.Max(value.yMin, clip.yMin), Mathf.Min(value.xMax, clip.xMax), Mathf.Min(value.yMax, clip.yMax));
        return value.width > 0 && value.height > 0;
    }
    static Rect ScreenRect(RectTransform rect, Camera camera)
    {
        var corners = new Vector3[4]; rect.GetWorldCorners(corners);
        Vector2 low = new Vector2(float.MaxValue, float.MaxValue), high = new Vector2(float.MinValue, float.MinValue);
        foreach (Vector3 corner in corners) { Vector2 p = RectTransformUtility.WorldToScreenPoint(camera, corner); low = Vector2.Min(low, p); high = Vector2.Max(high, p); }
        return Rect.MinMaxRect(low.x, low.y, high.x, high.y);
    }

    static void CaptureCamera(MonoBehaviour app, string path, Action<Camera> inspect)
    {
        Canvas canvas = (Canvas)Get(app, "canvas"); RenderMode oldMode = canvas.renderMode; Camera oldCamera = canvas.worldCamera;
        float oldPlane = canvas.planeDistance; var go = new GameObject("Editor preview capture camera") { hideFlags = HideFlags.HideAndDontSave };
        Camera camera = go.AddComponent<Camera>(); camera.enabled = false; camera.orthographic = true;
        camera.nearClipPlane = .1f; camera.farClipPlane = 1000; camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = new Color(.98f, .97f, .93f); camera.transform.position = new Vector3(0, 0, -100);
        RenderTexture texture = new RenderTexture(Width, Height, 24, RenderTextureFormat.ARGB32);
        Texture2D readback = null; RenderTexture previous = RenderTexture.active;
        try
        {
            texture.Create(); camera.targetTexture = texture; canvas.renderMode = RenderMode.ScreenSpaceCamera;
            canvas.worldCamera = camera; canvas.planeDistance = 1; ForceLayout(app); inspect?.Invoke(camera);
            camera.Render(); RenderTexture.active = texture; readback = new Texture2D(Width, Height, TextureFormat.RGB24, false);
            readback.ReadPixels(new Rect(0, 0, Width, Height), 0, 0); readback.Apply(); File.WriteAllBytes(path, readback.EncodeToPNG());
        }
        finally
        {
            canvas.renderMode = oldMode; canvas.worldCamera = oldCamera; canvas.planeDistance = oldPlane;
            RenderTexture.active = previous; camera.targetTexture = null; texture.Release();
            if (readback != null) UnityEngine.Object.DestroyImmediate(readback);
            UnityEngine.Object.DestroyImmediate(texture); UnityEngine.Object.DestroyImmediate(go); ForceLayout(app);
        }
    }

    static bool IsNonblankImage(string path, out string reason)
    {
        reason = "Screenshot not produced."; if (!File.Exists(path)) return false;
        Texture2D texture = null;
        try
        {
            byte[] bytes = File.ReadAllBytes(path); if (bytes.Length < 1000) { reason = "Screenshot file too small."; return false; }
            texture = new Texture2D(2, 2); if (!texture.LoadImage(bytes)) { reason = "PNG decode failed."; return false; }
            if (texture.width != Width || texture.height != Height) { reason = "GameView screenshot is not 432x900."; return false; }
            var palette = new HashSet<int>();
            for (int y = 8; y < Height; y += 17) for (int x = 8; x < Width; x += 17)
            { Color32 c = texture.GetPixel(x, y); palette.Add((c.r / 16 << 8) | (c.g / 16 << 4) | c.b / 16); }
            if (palette.Count < 12) { reason = "Screenshot has insufficient visible content/color variation."; return false; }
            reason = ""; return true;
        }
        catch (IOException) { reason = "Screenshot still being written."; return false; }
        finally { if (texture != null) UnityEngine.Object.DestroyImmediate(texture); }
    }

    static void ForceLayout(MonoBehaviour app)
    {
        Canvas.ForceUpdateCanvases();
        foreach (string field in new[] { "content", "modalContent" }) if (Get(app, field) is RectTransform rect) LayoutRebuilder.ForceRebuildLayoutImmediate(rect);
        Canvas.ForceUpdateCanvases();
    }
    static Type FindType(string name) => AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name, false)).FirstOrDefault(t => t != null) ?? throw new InvalidOperationException("Missing type: " + name);
    static MonoBehaviour FindApp() => UnityEngine.Object.FindObjectsOfType<MonoBehaviour>().FirstOrDefault(m => m.GetType().FullName == "Hegeng.FarmApp");
    static object Get(object target, string name)
    { Type t = target.GetType(); FieldInfo f = t.GetField(name, Instance); return f != null ? f.GetValue(target) : t.GetProperty(name, Instance)?.GetValue(target); }
    static void Set(object target, string name, object value) { target.GetType().GetField(name, Instance).SetValue(target, value); }
    static object Call(object target, string name, params object[] values)
    {
        MethodInfo method = target.GetType().GetMethods(Instance).FirstOrDefault(m => m.Name == name && m.GetParameters().Length >= values.Length && m.GetParameters().Skip(values.Length).All(p => p.IsOptional));
        Need(method != null, "Missing preview seam: " + name);
        ParameterInfo[] parameters = method.GetParameters(); object[] args = new object[parameters.Length];
        for (int i = 0; i < args.Length; i++) args[i] = i < values.Length ? values[i] : parameters[i].DefaultValue;
        return method.Invoke(target, args);
    }
    static void Need(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    static Exception Unwrap(Exception error) { while (error is TargetInvocationException && error.InnerException != null) error = error.InnerException; return error; }
    static string Output => SessionState.GetString(Prefix + "output", "");
    static void SetTime(string key, DateTime value) => SessionState.SetString(Prefix + key, value.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture));
    static DateTime Time(string key) => new DateTime(long.Parse(SessionState.GetString(Prefix + key, "0"), System.Globalization.CultureInfo.InvariantCulture), DateTimeKind.Utc);
    static void Failed() => SessionState.SetInt(Prefix + "failures", SessionState.GetInt(Prefix + "failures", 0) + 1);
    static void Append(string key, string json)
    { string old = SessionState.GetString(Prefix + key, ""); SessionState.SetString(Prefix + key, old + (old.Length == 0 ? "" : ",") + json); }
    static string Number(float value) => value.ToString("F2", System.Globalization.CultureInfo.InvariantCulture);
    static string Quote(string value)
    {
        var result = new StringBuilder("\""); foreach (char c in value ?? "")
        { if (c == '"' || c == '\\') result.Append('\\').Append(c); else if (c < 32) result.Append("\\u").Append(((int)c).ToString("x4")); else result.Append(c); }
        return result.Append('"').ToString();
    }
    static void Fatal(Exception failure)
    {
        failure = Unwrap(failure);
        if (SessionState.GetBool(Prefix + "active", false))
        { Append("errors", "{\"type\":\"probe\",\"message\":" + Quote(failure.Message) + ",\"stack\":" + Quote(failure.StackTrace) + "}"); Failed(); SessionState.SetString(Prefix + "stage", "leaving");
            if (EditorApplication.isPlayingOrWillChangePlaymode) EditorApplication.isPlaying = false; else Finish(); }
        else { Debug.LogError("HEGENG_PREVIEW_FAILED " + failure.Message); EditorApplication.Exit(1); }
    }
    static void Finish()
    {
        int failures = SessionState.GetInt(Prefix + "failures", 0);
        string report = "{\"evidence\":\"Unity Editor PlayMode only; not Android/device screenshots\",\"width\":432,\"height\":900,\"failures\":" + failures +
            ",\"pages\":[" + SessionState.GetString(Prefix + "pages", "") + "],\"regressions\":[" + SessionState.GetString(Prefix + "cases", "") +
            "],\"errors\":[" + SessionState.GetString(Prefix + "errors", "") + "]}";
        if (!string.IsNullOrEmpty(Output)) File.WriteAllText(Path.Combine(Output, "preview-report.json"), report + "\n", new UTF8Encoding(false));
        SessionState.SetBool(Prefix + "active", false); EditorApplication.update -= Tick; Application.logMessageReceived -= OnLog;
        // Release this probe's rendering windows before asking the batch editor to exit.
        foreach (EditorWindow window in Resources.FindObjectsOfTypeAll<EditorWindow>())
            if (window.GetType().FullName == "UnityEditor.GameView") window.Close();
        Debug.Log("HEGENG_PREVIEW_FINISHED failures=" + failures); EditorApplication.Exit(failures == 0 ? 0 : 1);
    }
}
