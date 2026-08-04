import fs from "node:fs";
import path from "node:path";
import type { OutboundMediaType } from "./gateway/types.js";

export interface NativeMediaDelivery {
  filePath: string;
  type: Exclude<OutboundMediaType, "document">;
  mimeType: string;
  voice?: boolean;
  gifPlayback?: boolean;
}

export interface LocationDelivery {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export interface MediaDelivery {
  text: string;
  documents: string[];
  media: NativeMediaDelivery[];
  locations: LocationDelivery[];
}

const DOCUMENT_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".pptx", ".csv", ".zip"];
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm"];
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".ogg", ".opus"];
const MEDIA_EXTENSIONS = [
  ...DOCUMENT_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
];

function isDeliverableMedia(filePath: string): boolean {
  return (
    MEDIA_EXTENSIONS.includes(path.extname(filePath).toLowerCase()) &&
    path.isAbsolute(filePath) &&
    fs.existsSync(filePath)
  );
}

function mediaTypeForFile(
  filePath: string
): Exclude<OutboundMediaType, "document"> | "document" | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (DOCUMENT_EXTENSIONS.includes(extension)) return "document";
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (VIDEO_EXTENSIONS.includes(extension)) return "video";
  if (AUDIO_EXTENSIONS.includes(extension)) return "audio";
  return undefined;
}

/**
 * Remove internal MEDIA markers from user-visible text and return existing
 * local files and locations that messaging adapters can deliver natively.
 */
export function extractMediaDelivery(text: string): MediaDelivery {
  const documents: string[] = [];
  const media: NativeMediaDelivery[] = [];
  const locations: LocationDelivery[] = [];
  const addMedia = (candidate: string, forceVoice = false): void => {
    const filePath = candidate
      .trim()
      .replace(/^["'`]|["'`,.;:)}\]]+$/g, "");
    if (!isDeliverableMedia(filePath)) return;

    const type = mediaTypeForFile(filePath);
    if (type === "document") {
      if (!documents.includes(filePath)) documents.push(filePath);
      return;
    }
    if (!type) return;
    const existing = media.find((item) => item.filePath === filePath);
    if (existing) {
      if (forceVoice && existing.type === "audio") existing.voice = true;
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    media.push({
      filePath,
      type,
      mimeType: mimeTypeForMedia(filePath),
      voice:
        type === "audio" &&
        (forceVoice || [".ogg", ".opus"].includes(extension)),
      gifPlayback: type === "image" && extension === ".gif",
    });
  };

  const mediaLinePattern = /^\s*MEDIA:\s*(.+?)\s*$/gm;
  let cleaned = text.replace(mediaLinePattern, (_match, rawPath: string) => {
    addMedia(rawPath);
    return "";
  });

  // Tool results often contain the tag inside JSON rather than on its own line.
  const inlineMediaPattern =
    /MEDIA:\s*(\/[^"'\r\n]+?\.(?:pdf|docx|xlsx|pptx|csv|zip|jpe?g|png|webp|gif|mp4|mov|webm|mp3|wav|m4a|ogg|opus))/gi;
  cleaned = cleaned.replace(inlineMediaPattern, (_match, rawPath: string) => {
    addMedia(rawPath);
    return "";
  });

  const voiceLinePattern = /^\s*VOICE:\s*(.+?)\s*$/gm;
  cleaned = cleaned.replace(voiceLinePattern, (_match, rawPath: string) => {
    addMedia(rawPath, true);
    return "";
  });

  const inlineVoicePattern =
    /VOICE:\s*(\/[^"'\r\n]+?\.(?:mp3|wav|m4a|ogg|opus))/gi;
  cleaned = cleaned.replace(inlineVoicePattern, (_match, rawPath: string) => {
    addMedia(rawPath, true);
    return "";
  });

  // Preserve compatibility with tool outputs that expose filePath without a
  // MEDIA tag. Limit discovery to generated-output and temporary directories.
  const localDocumentPattern =
    /(?:["'`])?(\/[^\s"'`]+\/(?:output\/(?:pdf|media)|tmp)\/[^\s"'`]+?\.(?:pdf|docx|xlsx|pptx|csv|zip|jpe?g|png|webp|gif|mp4|mov|webm|mp3|wav|m4a|ogg|opus))(?:["'`])?/g;
  cleaned = cleaned.replace(localDocumentPattern, (_match, rawPath: string) => {
    addMedia(rawPath);
    return "";
  });

  const locationPattern =
    /^\s*LOCATION:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*\|\s*([^|\n]*))?(?:\s*\|\s*([^\n]*))?\s*$/gm;
  cleaned = cleaned.replace(
    locationPattern,
    (
      _match,
      rawLatitude: string,
      rawLongitude: string,
      rawName?: string,
      rawAddress?: string
    ) => {
      const latitude = Number(rawLatitude);
      const longitude = Number(rawLongitude);
      if (
        latitude >= -90 &&
        latitude <= 90 &&
        longitude >= -180 &&
        longitude <= 180
      ) {
        locations.push({
          latitude,
          longitude,
          name: rawName?.trim() || undefined,
          address: rawAddress?.trim() || undefined,
        });
      }
      return "";
    }
  );

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return {
    text: cleaned,
    documents,
    media,
    locations,
  };
}

export function mimeTypeForDocument(filePath: string): string {
  return mimeTypeForMedia(filePath);
}

export function mimeTypeForMedia(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".ogg":
    case ".opus":
      return "audio/ogg; codecs=opus";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".csv":
      return "text/csv";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}
