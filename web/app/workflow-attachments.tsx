"use client";

import { useEffect, useRef, useState } from "react";

interface AttachmentSummary {
  id: string; fileName: string; category: string; readable: boolean; generated: boolean;
  warnings: string[]; expiresAt: string; downloadUrl: string;
}
interface Props { sessionId: string; disabled?: boolean; onChange: (ids: string[]) => void; onBusyChange?: (busy: boolean) => void }

export function WorkflowAttachments({ sessionId, disabled, onChange, onBusyChange }: Props) {
  const [files, setFiles] = useState<AttachmentSummary[]>([]);
  const [category, setCategory] = useState("party");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const requests = useRef<AbortController | null>(null);
  const onChangeRef = useRef(onChange);
  const onBusyChangeRef = useRef(onBusyChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onBusyChangeRef.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => { onBusyChangeRef.current?.(busy || loading); }, [busy, loading]);
  useEffect(() => () => onBusyChangeRef.current?.(false), []);
  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    setLoading(true);
    setFiles([]);
    setError("");
    onChangeRef.current([]);
    fetch(`/api/attachments?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load documents.");
        const body = await response.json() as { attachments: AttachmentSummary[] };
        if (controller.signal.aborted) return;
        setFiles(body.attachments || []);
        onChangeRef.current((body.attachments || []).filter((file) => !file.generated).slice(0, 12).map((file) => file.id));
      }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load documents."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId]);

  async function upload(file: File) {
    if (file.size > 15 * 1024 * 1024) { setError("Choose a document up to 15 MB."); return; }
    setBusy(true); setError("");
    const signal = requests.current?.signal;
    try {
      const form = new FormData();
      form.set("file", file); form.set("category", category); form.set("sessionId", sessionId);
      const response = await fetch("/api/attachments", { method: "POST", body: form, signal });
      const body = await response.json() as { attachment?: AttachmentSummary; error?: string };
      if (signal?.aborted) return;
      if (!response.ok || !body.attachment) throw new Error(body.error || "The document could not be uploaded.");
      const next = [body.attachment, ...files];
      setFiles(next);
      onChange(next.filter((item) => !item.generated).slice(0, 12).map((item) => item.id));
    } catch (failure) { if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "Upload failed."); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  }
  async function remove(id: string) {
    setBusy(true); setError("");
    const signal = requests.current?.signal;
    try {
      const response = await fetch(`/api/attachments?id=${encodeURIComponent(id)}`, { method: "DELETE", signal });
      if (signal?.aborted) return;
      if (!response.ok) throw new Error("The document could not be deleted.");
      const next = files.filter((file) => file.id !== id);
      setFiles(next); onChange(next.filter((file) => !file.generated).slice(0, 12).map((file) => file.id));
    } catch (failure) { if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "Deletion failed."); }
    finally { setBusy(false); }
  }

  return <details className="workflow-attachments" style={{ padding: "8px 12px", fontSize: 13 }}>
    <summary style={{ cursor: "pointer" }}>Documents{files.length ? ` (${files.length})` : ""}</summary>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
      <label>Document type{" "}<select aria-label="Document type" value={category} disabled={busy || loading || disabled} onChange={(event) => setCategory(event.target.value)}>
        <option value="party">Party identification</option><option value="transaction">Transaction</option><option value="other">Other document</option>
      </select></label>
      <input ref={input} type="file" accept=".pdf,.docx,.png,.jpg,.jpeg" aria-label="Upload supporting document" disabled={busy || loading || disabled}
        onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
    </div>
    <p style={{ margin: "8px 0", opacity: 0.75 }}>PDF, DOCX or image, up to 15 MB. NDA drafts need party and transaction documents. Uploads remain available in this conversation until their expiry date; you can delete them here.</p>
    {busy ? <p role="status">Processing document…</p> : loading ? <p role="status">Loading documents…</p> : null}
    {error ? <p role="alert" style={{ color: "#a32929" }}>{error}</p> : null}
    {files.length ? <ul style={{ paddingLeft: 18, margin: "8px 0" }}>{files.map((file) => <li key={file.id} style={{ marginBottom: 8 }}>
      <a href={file.downloadUrl}>{file.fileName}</a>{" "}<span style={{ opacity: 0.7 }}>· {file.category} · expires {new Date(file.expiresAt).toLocaleDateString()}</span>{" "}
      <button type="button" disabled={busy || loading || disabled} onClick={() => void remove(file.id)} aria-label={`Delete ${file.fileName}`}>Delete</button>
      {!file.generated && !file.readable ? <div role="status">This document could not be read. Upload a clearer copy.</div> : null}
      {file.warnings.length ? <div style={{ opacity: 0.8 }}>{file.warnings.join(" ")}</div> : null}
    </li>)}</ul> : null}
  </details>;
}
