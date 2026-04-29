package com.liuhui.app;

import android.content.ContentValues;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.util.Base64;
import android.net.Uri;
import android.content.Context;
import android.database.Cursor;

import com.getcapacitor.BridgeActivity;

import java.io.OutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends BridgeActivity {
    @Override
    public void onStart() {
        super.onStart();
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            webView.addJavascriptInterface(new GalleryBridge(this), "LiuHuiGallery");
        }
    }

    public static class GalleryBridge {
        private final Context context;

        GalleryBridge(Context context) {
            this.context = context;
        }

        @JavascriptInterface
        public String saveBase64ToAppFile(String base64, String mimeType, String prefix) {
            try {
                if (base64 == null || base64.trim().isEmpty()) return "ERR:empty-base64";
                String clean = base64;
                int comma = clean.indexOf(',');
                if (clean.startsWith("data:") && comma >= 0) clean = clean.substring(comma + 1);
                byte[] bytes = Base64.decode(clean, Base64.DEFAULT);
                String safeMime = (mimeType == null || mimeType.trim().isEmpty()) ? "image/png" : mimeType.trim();
                String ext = safeMime.contains("jpeg") ? "jpg" : safeMime.contains("webp") ? "webp" : safeMime.contains("gif") ? "gif" : "png";
                File dir = new File(context.getFilesDir(), "liuhui-images");
                if (!dir.exists() && !dir.mkdirs()) return "ERR:mkdir-failed";
                String name = (prefix == null || prefix.trim().isEmpty() ? "liuhui" : prefix.trim()) + "_" + new SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(new Date()) + "." + ext;
                File file = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                    out.flush();
                }
                return "OK:" + file.getAbsolutePath();
            } catch (Throwable t) {
                return "ERR:" + t.getClass().getSimpleName() + ":" + String.valueOf(t.getMessage());
            }
        }

        @JavascriptInterface
        public String saveBase64Image(String base64, String mimeType, String prefix) {
            try {
                if (base64 == null || base64.trim().isEmpty()) {
                    return "ERR:empty-base64";
                }
                String clean = base64;
                int comma = clean.indexOf(',');
                if (clean.startsWith("data:") && comma >= 0) {
                    clean = clean.substring(comma + 1);
                }
                byte[] bytes = Base64.decode(clean, Base64.DEFAULT);
                String safeMime = (mimeType == null || mimeType.trim().isEmpty()) ? "image/png" : mimeType.trim();
                String ext = safeMime.contains("jpeg") ? "jpg" : safeMime.contains("webp") ? "webp" : safeMime.contains("gif") ? "gif" : "png";
                String name = (prefix == null || prefix.trim().isEmpty() ? "liuhui" : prefix.trim()) + "_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date()) + "." + ext;

                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                values.put(MediaStore.Images.Media.MIME_TYPE, safeMime);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/LiuHui");
                    values.put(MediaStore.Images.Media.IS_PENDING, 1);
                }

                Uri uri = context.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return "ERR:insert-failed";

                try (OutputStream out = context.getContentResolver().openOutputStream(uri)) {
                    if (out == null) return "ERR:open-output-failed";
                    out.write(bytes);
                    out.flush();
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.Images.Media.IS_PENDING, 0);
                    context.getContentResolver().update(uri, done, null, null);
                }
                return "OK:" + uri.toString();
            } catch (Throwable t) {
                return "ERR:" + t.getClass().getSimpleName() + ":" + String.valueOf(t.getMessage());
            }
        }
    }
}
