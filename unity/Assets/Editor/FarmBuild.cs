using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

// Editor-only. Runtime entry belongs to FarmApp's RuntimeInitializeOnLoadMethod.
public static class FarmBuild
{
    private const string PackageId = "com.hegeng.xiaoshe.demo";
    private const string OutputEnvironment = "HEGENG_UNITY_APK_OUTPUT";
    private const string ScenePath = "Assets/Scenes/Farm.unity";

    [MenuItem("合耕小舍/构建安卓体验包")]
    public static void BuildFromMenu()
    {
        string target=EditorUtility.SaveFilePanel("保存安卓体验包", "", "合耕小舍-Unity体验版.apk", "apk");
        if(string.IsNullOrEmpty(target))return;
        if(!EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Android,BuildTarget.Android))
            throw new BuildFailedException("Cannot switch this editor to the Android target.");
        string previous=Environment.GetEnvironmentVariable(OutputEnvironment);
        try {Environment.SetEnvironmentVariable(OutputEnvironment,target);BuildAndroid();}
        finally {Environment.SetEnvironmentVariable(OutputEnvironment,previous);}
    }

    public static void BuildAndroid()
    {
        string output = Environment.GetEnvironmentVariable(OutputEnvironment);
        if (string.IsNullOrEmpty(output) || !Path.IsPathRooted(output) ||
            !string.Equals(Path.GetExtension(output), ".apk", StringComparison.OrdinalIgnoreCase))
            throw new BuildFailedException("An absolute HEGENG_UNITY_APK_OUTPUT .apk path is required.");

        if (EditorUserBuildSettings.activeBuildTarget != BuildTarget.Android)
            throw new BuildFailedException("Start Unity with -buildTarget Android.");

        // Fail the build before producing an APK if any domain rule regresses.
        Hegeng.FarmChecks.RunAll();
        ConfigurePlayer();
        ConfigurePhotos();
        ConfigureIcon();
        Directory.CreateDirectory("Assets/Scenes");
        Scene empty = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        if (!EditorSceneManager.SaveScene(empty, ScenePath))
            throw new BuildFailedException("Failed to create the bootstrap scene.");
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        AssetDatabase.SaveAssets();
        Directory.CreateDirectory(Path.GetDirectoryName(output));

        BuildReport report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { ScenePath }, locationPathName = output,
            target = BuildTarget.Android, options = BuildOptions.None
        });
        if (report.summary.result != BuildResult.Succeeded)
            throw new BuildFailedException("Farm Android build failed: " + report.summary.result);
        if (!File.Exists(output) || new FileInfo(output).Length == 0)
            throw new BuildFailedException("Unity reported success without a non-empty APK.");
        Debug.Log("HEGENG_BUILD_SUCCEEDED package=" + PackageId + " version=0.1.0");
    }

    private static void ConfigurePlayer()
    {
        var settingsAsset=AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/ProjectSettings.asset");
        var settings=new SerializedObject(settingsAsset[0]);
        var input=settings.FindProperty("activeInputHandler");
        if(input==null)throw new BuildFailedException("Missing player input configuration.");
        input.intValue=0;settings.ApplyModifiedPropertiesWithoutUndo();
        PlayerSettings.companyName = "HeGeng";
        PlayerSettings.productName = "合耕小舍";
        PlayerSettings.bundleVersion = "0.1.0";
        PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Android, PackageId);
        PlayerSettings.defaultInterfaceOrientation = UIOrientation.Portrait;
        PlayerSettings.allowedAutorotateToPortrait = false;
        PlayerSettings.allowedAutorotateToPortraitUpsideDown = false;
        PlayerSettings.allowedAutorotateToLandscapeLeft = false;
        PlayerSettings.allowedAutorotateToLandscapeRight = false;
        PlayerSettings.runInBackground = false;
        PlayerSettings.Android.bundleVersionCode = 1;
        PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel24;
        PlayerSettings.Android.targetSdkVersion = AndroidSdkVersions.AndroidApiLevel34;
        PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64 | AndroidArchitecture.ARMv7;
        PlayerSettings.Android.forceInternetPermission = false;
        PlayerSettings.Android.forceSDCardPermission = false;
        PlayerSettings.Android.useCustomKeystore = false;
        PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, ScriptingImplementation.IL2CPP);
        PlayerSettings.SetIl2CppCompilerConfiguration(NamedBuildTarget.Android, Il2CppCompilerConfiguration.Release);
        PlayerSettings.SetManagedStrippingLevel(NamedBuildTarget.Android, ManagedStrippingLevel.Low);
        EditorUserBuildSettings.androidBuildSystem = AndroidBuildSystem.Gradle;
        EditorUserBuildSettings.buildAppBundle = false;
        EditorUserBuildSettings.exportAsGoogleAndroidProject = false;
        EditorUserBuildSettings.development = false;
        EditorUserBuildSettings.allowDebugging = false;
        EditorUserBuildSettings.connectProfiler = false;
    }

    private static void ConfigurePhotos()
    {
        string[] photographs = Directory.GetFiles("Assets/Resources/Photos", "*.jpg", SearchOption.TopDirectoryOnly);
        if (photographs.Length != 25) throw new BuildFailedException("Expected exactly 25 canonical photo derivatives.");
        foreach (string file in photographs)
        {
            string assetPath = file.Replace('\\', '/');
            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer == null) throw new BuildFailedException("Photo import missing: " + assetPath);
            FarmPhotoImport.Apply(importer);
            importer.SaveAndReimport();
        }
        var font = AssetDatabase.LoadAssetAtPath<Font>("Assets/Resources/Fonts/NotoSansCJKsc.otf");
        if (font == null) throw new BuildFailedException("The approved Noto CJK font did not import.");
    }

    private static void ConfigureIcon()
    {
        const string path = "Assets/Brand/HeGengIcon.png";
        Directory.CreateDirectory("Assets/Brand");
        var texture = new Texture2D(512,512,TextureFormat.RGBA32,false);
        var pixels = new Color[512*512];
        for(int i=0;i<pixels.Length;i++) pixels[i]=Hegeng.FarmTheme.Action;
        texture.SetPixels(pixels);
        // Same restrained leaf mark as the app header. This is a UI icon, not a scene asset.
        var points=new[]{new Vector2(.28f,.29f),new Vector2(.24f,.53f),new Vector2(.36f,.74f),new Vector2(.78f,.8f),new Vector2(.75f,.4f),new Vector2(.56f,.24f),new Vector2(.28f,.29f)};
        for(int i=0;i<points.Length-1;i++) DrawLine(texture,points[i],points[i+1]);
        DrawLine(texture,new Vector2(.24f,.2f),new Vector2(.62f,.62f));
        texture.Apply();File.WriteAllBytes(path,texture.EncodeToPNG());UnityEngine.Object.DestroyImmediate(texture);
        AssetDatabase.ImportAsset(path,ImportAssetOptions.ForceSynchronousImport);
        var icon=AssetDatabase.LoadAssetAtPath<Texture2D>(path);
        PlayerSettings.SetIconsForTargetGroup(BuildTargetGroup.Unknown,new[]{icon});
    }
    private static void DrawLine(Texture2D texture,Vector2 a,Vector2 b)
    {
        a*=512;b*=512;float length=Vector2.Distance(a,b);
        for(int i=0;i<=length;i++)
        {
            var p=Vector2.Lerp(a,b,i/length);
            for(int y=-11;y<=11;y++)for(int x=-11;x<=11;x++)
            {int px=(int)p.x+x,py=(int)p.y+y;if(x*x+y*y<=121&&px>=0&&py>=0&&px<512&&py<512)texture.SetPixel(px,py,Hegeng.FarmTheme.Ink);}
        }
    }
}
