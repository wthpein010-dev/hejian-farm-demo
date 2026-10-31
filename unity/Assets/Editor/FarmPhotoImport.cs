using UnityEditor;
using UnityEngine;

// Import is correct on first project open, not only after running Android build.
public sealed class FarmPhotoImport : AssetPostprocessor
{
    void OnPreprocessTexture()
    {
        if(assetPath.StartsWith("Assets/Resources/Photos/")&&assetPath.EndsWith(".jpg"))
            Apply((TextureImporter)assetImporter);
    }
    internal static void Apply(TextureImporter importer)
    {
        importer.textureType=TextureImporterType.Sprite;
        importer.spriteImportMode=SpriteImportMode.Single;
        importer.spritePixelsPerUnit=100;
        importer.mipmapEnabled=false;
        importer.sRGBTexture=true;
        importer.alphaSource=TextureImporterAlphaSource.None;
        importer.filterMode=FilterMode.Bilinear;
        importer.wrapMode=TextureWrapMode.Clamp;
        importer.maxTextureSize=1024;
        importer.textureCompression=TextureImporterCompression.Compressed;
    }
}
