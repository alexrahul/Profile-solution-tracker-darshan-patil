import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const allowedTypes = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"]
]);

let client;
let bucketReady = false;

function storageConfig() {
  const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "").trim();
  const bucket = String(process.env.SUPABASE_STORAGE_BUCKET || "manpower-images").trim();

  if (!url || !serviceKey) {
    const err = new Error("Supabase Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) in backend/.env");
    err.status = 503;
    throw err;
  }
  return { url, serviceKey, bucket };
}

function supabase() {
  if (!client) {
    const { url, serviceKey } = storageConfig();
    client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return client;
}

export function validateImageFile(file) {
  if (!file) {
    const err = new Error("Image file is required");
    err.status = 400;
    throw err;
  }
  if (!allowedTypes.has(file.mimetype)) {
    const err = new Error("Only JPG, JPEG, PNG and WEBP images are supported");
    err.status = 400;
    throw err;
  }
}

export async function ensureImageBucket() {
  if (bucketReady) return;
  const { bucket } = storageConfig();
  const sb = supabase();
  const { data, error } = await sb.storage.getBucket(bucket);
  if (error || !data) {
    const created = await sb.storage.createBucket(bucket, {
      public: true,
      allowedMimeTypes: [...allowedTypes.keys()],
      fileSizeLimit: 10 * 1024 * 1024
    });
    if (created.error && !/already exists/i.test(created.error.message || "")) {
      const err = new Error(`Unable to prepare Supabase Storage bucket: ${created.error.message}`);
      err.status = 502;
      throw err;
    }
  } else if (!data.public) {
    const updated = await sb.storage.updateBucket(bucket, {
      public: true,
      allowedMimeTypes: [...allowedTypes.keys()],
      fileSizeLimit: 10 * 1024 * 1024
    });
    if (updated.error) {
      const err = new Error(`Unable to make Supabase Storage bucket public: ${updated.error.message}`);
      err.status = 502;
      throw err;
    }
  }
  bucketReady = true;
}

export async function uploadManpowerImage(file, date) {
  validateImageFile(file);
  await ensureImageBucket();
  const { bucket } = storageConfig();
  const ext = allowedTypes.get(file.mimetype);
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? date : "undated";
  const path = `${safeDate}/${crypto.randomUUID()}.${ext}`;
  const sb = supabase();

  const { error } = await sb.storage.from(bucket).upload(path, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
    cacheControl: "3600"
  });
  if (error) {
    const err = new Error(`Image upload failed: ${error.message}`);
    err.status = 502;
    throw err;
  }

  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  return { imageUrl: data.publicUrl, storagePath: path };
}

export async function deleteManpowerImage(storagePath) {
  if (!storagePath) return;
  try {
    await ensureImageBucket();
    const { bucket } = storageConfig();
    await supabase().storage.from(bucket).remove([storagePath]);
  } catch (err) {
    console.warn("Unable to remove image from Supabase Storage:", err.message);
  }
}
