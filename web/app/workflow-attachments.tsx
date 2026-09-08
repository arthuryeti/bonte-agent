"use client";

import { useEffect, useRef, useState } from "react";

interface AttachmentSummary {
  id: string; fileName: string; category: string; readable: boolean; generated: boolean;
  warnings: string[]; expiresAt: string; downloadUrl: string;
}
interface Props { sessionId: string; disabled?: boolean; onChange: (ids: string[]) => void; onBusyChange?: (busy: boolean) => void }

const sourceIds = (list: AttachmentSummary[]) => list.filter((file) => !file.generated).slice(0, 12).map((file) => file.id);

export function WorkflowAttachments({ sessionId, disabled, onChange, onBusyChange }: Props) {
  const [files, setFiles] = useState<AttachmentSummary[]>([]);
  const [category, setCategory] = useState("party");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState("");
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
    setProgress("");
    onChangeRef.current([]);
    fetch(`/api/attachments?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load documents.");
        const body = await response.json() as { attachments: AttachmentSummary[] };
        if (controller.signal.aborted) return;
        setFiles(body.attachments || []);
        onChangeRef.current(sourceIds(body.attachments || []));
      }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load documents."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId]);

  async function uploadAll(selected: File[]) {
    setBusy(true); setError("");
    const signal = requests.current?.signal;
    const kind = category;
    let current = files;
    const failures: string[] = [];
    try {
      for (let index = 0; index < selected.length; index++) {
        if (signal?.aborted) return;
        const file = selected[index];
        setProgress(`Uploading ${index + 1} of ${selected.length}…`);
        if (file.size > 15 * 1024 * 1024) { failures.push(`${file.name}: Choose a document up to 15 MB.`); continue; }
        try {
          const form = new FormData();
          form.set("file", file); form.set("category", kind); form.set("sessionId", sessionId);
          const response = await fetch("/api/attachments", { method: "POST", body: form, signal });
          const body = await response.json() as { attachment?: AttachmentSummary; error?: string };
          if (signal?.aborted) return;
          if (!response.ok || !body.attachment) throw new Error(body.error || "The document could not be uploaded.");
          current = [body.attachment, ...current];
          setFiles(current);
          onChangeRef.current(sourceIds(current));
        } catch (failure) {
          if (signal?.aborted) return;
          failures.push(`${file.name}: ${failure instanceof Error ? failure.message : "Upload failed."}`);
        }
      }
      if (!signal?.aborted) setError(failures.join(" "));
    } finally {
      if (!signal?.aborted) { setBusy(false); setProgress(""); if (input.current) input.current.value = ""; }
    }
  }
  async function remove(id: string) {
    setBusy(true); setError(""); setProgress("");
    const signal = requests.current?.signal;
    try {
      const response = await fetch(`/api/attachments?id=${encodeURIComponent(id)}`, { method: "DELETE", signal });
      if (signal?.aborted) return;
      if (!response.ok) throw new Error("The document could not be deleted.");
      const next = files.filter((file) => file.id !== id);
      setFiles(next); onChangeRef.current(sourceIds(next));
    } catch (failure) { if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "Deletion failed."); }
    finally { if (!signal?.aborted) setBusy(false); }
  }

  const locked = busy || loading || disabled;
  const overLimit = files.filter((file) => !file.generated).length > 12;
  return <div className="workflow-attachments">
    <details className="attachment-menu">
      <summary>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg>
        {files.length ? `Documents (${files.length})` : "Attach files"}
      </summary>
      <div className="attachment-menu-content">
    <div className="workflow-attachments-bar">
      <strong>Supporting documents</strong>
      <label>Type{" "}<select aria-label="Document type" value={category} disabled={locked} onChange={(event) => setCategory(event.target.value)}>
        <option value="party">Party identification</option><option value="transaction">Transaction</option><option value="other">Other document</option>
      </select></label>
      <input ref={input} type="file" multiple accept=".pdf,.docx,.png,.jpg,.jpeg,.webp" aria-label="Attach supporting documents" disabled={locked}
        onChange={(event) => { const selected = Array.from(event.target.files || []); event.target.value = ""; if (selected.length) void uploadAll(selected); }} />
    </div>
    <p>PDF, DOCX, JPEG, PNG or WebP, up to 15 MB each. NDA/CMI: passport photos and client/agent IDs as Party identification; property and deal documents as Transaction.</p>
    {files.length ? <ul className="workflow-attachments-list">{files.map((file) => <li key={file.id}>
      <a href={file.downloadUrl}>{file.fileName}</a>{" "}<span>· {file.category} · expires {new Date(file.expiresAt).toLocaleDateString()}</span>{" "}
      <button type="button" disabled={locked} onClick={() => void remove(file.id)} aria-label={`Delete ${file.fileName}`}>Delete</button>
      {!file.generated && !file.readable && !file.warnings.length ? <div role="status">This document could not be read.</div> : null}
      {file.warnings.length ? <div>{file.warnings.join(" ")}</div> : null}
    </li>)}</ul> : null}
      </div>
    </details>
    {progress ? <p role="status">{progress}</p> : busy ? <p role="status">Processing document…</p> : loading ? <p role="status">Loading documents…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {overLimit ? <p role="status">Only the first 12 supporting documents are included with the next message. Remove one to include another.</p> : null}
  </div>;
}
