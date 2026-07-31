import fs from "node:fs";
import path from "node:path";

export interface MediaDelivery {
  text: string;
  documents: string[];
}

const DOCUMENT_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".pptx", ".csv", ".zip"];

function isDeliverableDocument(filePath: string): boolean {
  return (
    DOCUMENT_EXTENSIONS.includes(path.extname(filePath).toLowerCase()) &&
    path.isAbsolute(filePath) &&
    fs.existsSync(filePath)
  );
}

/**
 * Remove internal MEDIA markers from user-visible text and return existing
 * local documents that messaging adapters can upload.
 */
export function extractMediaDelivery(text: string): MediaDelivery {
  const documents: string[] = [];
  const addDocument = (candidate: string): void => {
    const documentPath = candidate
      .trim()
      .replace(/^["'`]|["'`,.;:)}\]]+$/g, "");
    if (
      isDeliverableDocument(documentPath) &&
      !documents.includes(documentPath)
    ) {
      documents.push(documentPath);
    }
  };

  const mediaLinePattern = /^\s*MEDIA:\s*(.+?)\s*$/gm;
  let cleaned = text.replace(mediaLinePattern, (_match, rawPath: string) => {
    addDocument(rawPath);
    return "";
  });

  // Tool results often contain the tag inside JSON rather than on its own line.
  const inlineMediaPattern =
    /MEDIA:\s*(\/[^"'\r\n]+?\.(?:pdf|docx|xlsx|pptx|csv|zip))/gi;
  cleaned = cleaned.replace(inlineMediaPattern, (_match, rawPath: string) => {
    addDocument(rawPath);
    return "";
  });

  // Preserve compatibility with tool outputs that expose filePath without a
  // MEDIA tag. Limit discovery to generated-output and temporary directories.
  const localDocumentPattern =
    /(?:["'`])?(\/[^\s"'`]+\/(?:output\/pdf|tmp)\/[^\s"'`]+?\.(?:pdf|docx|xlsx|pptx|csv|zip))(?:["'`])?/g;
  cleaned = cleaned.replace(localDocumentPattern, (_match, rawPath: string) => {
    addDocument(rawPath);
    return "";
  });

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return {
    text: cleaned,
    documents,
  };
}

export function mimeTypeForDocument(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
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
