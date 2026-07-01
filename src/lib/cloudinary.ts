/* Cloudinary image storage. Swap-out point for AWS S3 / other object storage
   later — callers only depend on `uploadImage` returning a public URL. */
import { v2 as cloudinary } from "cloudinary";

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

cloudinary.config({
  cloud_name: CLOUD_NAME,
  api_key: API_KEY,
  api_secret: API_SECRET,
  secure: true,
});

/** True only when all three credentials are present, so routes can fail with a
    clear message instead of a cryptic Cloudinary error. */
export const cloudinaryConfigured = Boolean(CLOUD_NAME && API_KEY && API_SECRET);

export type UploadResult = { url: string; publicId: string };

/** Upload an in-memory image buffer and resolve to its secure URL + publicId. */
export function uploadImage(
  buffer: Buffer,
  folder = "av-creation/products"
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (err, result) => {
        if (err || !result) {
          reject(err ?? new Error("Upload failed"));
          return;
        }
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

/** Upload an in-memory video buffer (e.g. a social reel) and resolve to its
    secure URL + publicId. Same swap-out contract as `uploadImage`. */
export function uploadVideo(
  buffer: Buffer,
  folder = "av-creation/social"
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "video" },
      (err, result) => {
        if (err || !result) {
          reject(err ?? new Error("Upload failed"));
          return;
        }
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

export { cloudinary };
