"use client";

import { useState } from "react";
import { emailDraftMailto, isEmailDraftView } from "./email-draft-data";

export function EmailDraft({ data }: { data: unknown }) {
  const [copyStatus, setCopyStatus] = useState("");
  if (!isEmailDraftView(data)) return <p role="alert">This email draft could not be displayed safely. Ask the assistant to recall it again.</p>;
  const mailto = emailDraftMailto(data);
  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(`${data.recipient ? `To: ${data.recipient}\n` : ""}Subject: ${data.subject}\n\n${data.body}`);
      setCopyStatus("Draft copied.");
    } catch {
      setCopyStatus("Copy failed. Download the TXT file or select and copy the draft text below.");
    }
  };

  return (
    <section className="lead-results email-draft" aria-label={`Email draft revision ${data.revision}: ${data.subject}`}>
      <div className="lead-results-head">
        <div><p className="eyebrow">Email draft · Revision {data.revision}</p><h2>{data.subject || "No subject"}</h2></div>
      </div>
      <p>{data.recipient ? `To: ${data.recipient}` : "To is blank — choose a recipient in your mail app."}</p>
      <div className="email-draft-actions">
        <a className="pdf-download" href={mailto}>Send via mail app</a>
        <a className="pdf-download" href={`/api/attachments?id=${encodeURIComponent(data.downloadAttachmentId)}`} download>Download TXT</a>
        <button className="pdf-download" type="button" onClick={copyDraft}>Copy draft</button>
      </div>
      <p className="email-draft-note">Review and send in your mail app. If text is missing, use Copy or TXT.</p>
      {data.attachmentIds.length ? <>
        <p className="email-draft-note">Download attachments and add them manually.</p>
        <div className="email-draft-actions">
          {data.attachmentIds.map((id, index) => <a className="pdf-download" href={`/api/attachments?id=${encodeURIComponent(id)}`} key={id} download>Download attachment {index + 1}</a>)}
        </div>
      </> : null}
      {copyStatus ? <p role="status">{copyStatus}</p> : null}
      <details><summary>Draft text</summary><pre>{data.body}</pre></details>
    </section>
  );
}
