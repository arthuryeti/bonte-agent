"use client";

import {
  FormEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  CrmToolStatusView,
  LeadListView,
  LeadView,
} from "./chat-types";

interface LeadResultsProps {
  data: LeadListView;
  onSelect: (lead: LeadView) => void;
}

interface ToolStatusProps {
  data: CrmToolStatusView;
}

export interface FollowUpValues {
  scheduledFor: string;
  note?: string;
}

interface LeadDrawerProps {
  lead: LeadView;
  disabled: boolean;
  onClose: () => void;
  onRefresh: (lead: LeadView) => void;
  onSchedule: (lead: LeadView, values: FollowUpValues) => void;
}

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const LEAD_PREVIEW_LIMIT = 3;

function formatDate(value?: string, includeTime = false): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return includeTime ? dateTimeFormatter.format(date) : dateFormatter.format(date);
}

function formatPrice(value?: string): string | undefined {
  if (!value) return undefined;
  const number = Number(value.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return value;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(number);
}

function statusTone(status?: string): string {
  const value = status?.toLowerCase() ?? "";
  if (/won|complete|closed/.test(value)) return "positive";
  if (/lost|cancel|reject/.test(value)) return "negative";
  if (/new|open/.test(value)) return "new";
  if (/progress|contact|view|follow/.test(value)) return "active";
  return "neutral";
}

function leadName(lead: LeadView): string {
  return lead.contact?.name || lead.title;
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "L";
}

function tomorrowAtTen(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(10, 0, 0, 0);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function phoneLinks(phone?: string) {
  if (!phone) return undefined;
  const whatsapp = phone.replace(/\D/g, "");
  return {
    telephone: `tel:${phone.replace(/[^\d+*#,;]/g, "")}`,
    whatsapp: whatsapp ? `https://wa.me/${whatsapp}` : undefined,
  };
}

export function ToolStatus({ data }: ToolStatusProps) {
  if (data.status === "complete") return null;

  const isError = data.status === "error";
  return (
    <div
      className={`tool-status ${data.status}`}
      role={isError ? "alert" : "status"}
      aria-live="polite"
    >
      <span className="tool-status-indicator" aria-hidden="true">
        {isError ? "!" : null}
      </span>
      <span>{data.label}</span>
    </div>
  );
}

export function LeadResults({ data, onSelect }: LeadResultsProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  if (data.leads.length === 0) {
    return (
      <section className="lead-results lead-results-empty" aria-label="Lead results">
        <p>No matching leads were returned by the CRM.</p>
      </section>
    );
  }

  const canExpand = data.leads.length > LEAD_PREVIEW_LIMIT;
  const visibleLeads = expanded
    ? data.leads
    : data.leads.slice(0, LEAD_PREVIEW_LIMIT);
  const hiddenLeadCount = data.leads.length - visibleLeads.length;

  return (
    <section className="lead-results" aria-label="Lead results">
      <div className="lead-results-head">
        <div>
          <p className="eyebrow">CRM result</p>
          <h2>
            {data.returnedRecords} {data.returnedRecords === 1 ? "lead" : "leads"}
          </h2>
        </div>
        <span className="lead-results-total">
          {data.totalRecords > data.returnedRecords
            ? `${data.totalRecords} total`
            : "Live"}
        </span>
      </div>

      <div className="lead-list" id={listId}>
        {visibleLeads.map((lead) => {
          const name = leadName(lead);
          const date = formatDate(lead.updatedAt || lead.createdAt);
          const price = formatPrice(lead.salePrice);
          return (
            <button
              className="lead-row"
              key={lead.id}
              type="button"
              onClick={() => onSelect(lead)}
              aria-label={`View ${name}`}
            >
              <span className="lead-primary">
                <span className="lead-name-line">
                  <strong>{name}</strong>
                  {lead.status ? (
                    <span className={`status-pill ${statusTone(lead.status)}`}>
                      {lead.status}
                    </span>
                  ) : null}
                </span>
                <span className="lead-meta">
                  {lead.title !== name ? <span>{lead.title}</span> : null}
                  {lead.properties[0]?.reference ? <span>{lead.properties[0].reference}</span> : null}
                  {lead.agents[0]?.name ? <span>{lead.agents[0].name}</span> : null}
                  {date ? <span>{date}</span> : null}
                </span>
              </span>
              <span className="lead-row-end">
                {price ? <strong>{price}</strong> : null}
                <span aria-hidden="true">›</span>
              </span>
            </button>
          );
        })}
      </div>
      {canExpand ? (
        <div className="lead-results-actions">
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
            aria-controls={listId}
          >
            {expanded ? "Collapse list" : `Show ${hiddenLeadCount} more`}
          </button>
          {expanded && data.truncated ? (
            <span>Showing the newest matches. Refine your request for a narrower result.</span>
          ) : null}
        </div>
      ) : data.truncated ? (
        <p className="lead-results-foot">Refine your request to narrow the full result set.</p>
      ) : null}
    </section>
  );
}

export function LeadDrawer({
  lead,
  disabled,
  onClose,
  onRefresh,
  onSchedule,
}: LeadDrawerProps) {
  const [scheduling, setScheduling] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState("");
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const contactName = leadName(lead);
  const links = phoneLinks(lead.contact?.phone);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const openScheduler = () => {
    setScheduledFor(tomorrowAtTen());
    setScheduling(true);
    setFormError("");
  };

  const submitFollowUp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const date = new Date(scheduledFor);
    if (!scheduledFor || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
      setFormError("Choose a future date and time.");
      return;
    }
    onSchedule(lead, {
      scheduledFor: date.toISOString(),
      note: note.trim() || undefined,
    });
  };

  const copyLeadId = async () => {
    try {
      await navigator.clipboard.writeText(lead.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="lead-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lead-drawer-title"
      >
        <header className="drawer-header">
          <div className="drawer-person">
            <span className="drawer-avatar" aria-hidden="true">{initials(contactName)}</span>
            <div>
              <p className="eyebrow">Lead details</p>
              <h2 id="lead-drawer-title">{contactName}</h2>
              {lead.title !== contactName ? <p>{lead.title}</p> : null}
            </div>
          </div>
          <button ref={closeRef} className="drawer-close" type="button" onClick={onClose} aria-label="Close lead details">×</button>
        </header>

        <div className="drawer-scroll">
          <div className="drawer-summary">
            {lead.status ? <span className={`status-pill ${statusTone(lead.status)}`}>{lead.status}</span> : null}
            {lead.priority ? <span className="priority-pill">{lead.priority} priority</span> : null}
            {lead.origin ? <span className="plain-pill">{lead.origin}</span> : null}
          </div>

          <div className="contact-actions" aria-label="Lead contact actions">
            {links?.telephone ? <a href={links.telephone}>Call</a> : null}
            {lead.contact?.email ? <a href={`mailto:${lead.contact.email}`}>Email</a> : null}
            {links?.whatsapp ? (
              <a href={links.whatsapp} target="_blank" rel="noreferrer">WhatsApp</a>
            ) : null}
            {lead.crmUrl ? (
              <a href={lead.crmUrl} target="_blank" rel="noreferrer">Open CRM</a>
            ) : null}
          </div>

          <section className="drawer-section">
            <div className="section-title">
              <h3>Contact</h3>
              <button type="button" onClick={copyLeadId}>{copied ? "Copied" : "Copy lead ID"}</button>
            </div>
            <dl className="detail-grid">
              <div><dt>Email</dt><dd>{lead.contact?.email || "Not available"}</dd></div>
              <div><dt>Phone</dt><dd>{lead.contact?.phone || "Not available"}</dd></div>
              <div><dt>Assigned to</dt><dd>{lead.agents.map((agent) => agent.name).join(", ") || "Unassigned"}</dd></div>
              <div><dt>Created</dt><dd>{formatDate(lead.createdAt) || "Not available"}</dd></div>
            </dl>
          </section>

          <section className="drawer-section">
            <div className="section-title">
              <h3>Related properties</h3>
              <span>{lead.propertyCount}</span>
            </div>
            {lead.properties.length > 0 ? (
              <div className="property-stack">
                {lead.properties.map((property, index) => (
                  <div className="property-item" key={property.id || property.reference || index}>
                    <div>
                      <strong>{property.reference || `Property ${index + 1}`}</strong>
                      <span>{property.address || "Address not available"}</span>
                    </div>
                    {formatPrice(property.price) ? <strong>{formatPrice(property.price)}</strong> : null}
                  </div>
                ))}
              </div>
            ) : <p className="empty-copy">No related property was included in this result.</p>}
          </section>

          <section className="drawer-section">
            <div className="section-title">
              <h3>Recent activity</h3>
              <span>{lead.eventCount}</span>
            </div>
            {lead.events.length > 0 ? (
              <ol className="timeline">
                {lead.events.map((activity, index) => (
                  <li key={activity.id || `${activity.title}-${index}`}>
                    <span aria-hidden="true" />
                    <div>
                      <strong>{activity.title}</strong>
                      <p>{[activity.type, activity.location].filter(Boolean).join(" · ") || "CRM activity"}</p>
                      {activity.startsAt ? <time>{formatDate(activity.startsAt, true)}</time> : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : <p className="empty-copy">No recent activity was included in this result.</p>}
          </section>

          <button className="refresh-lead" type="button" onClick={() => onRefresh(lead)} disabled={disabled}>
            Fetch latest details from CRM
          </button>
        </div>

        <footer className={`drawer-footer ${scheduling ? "scheduling" : ""}`}>
          {scheduling ? (
            <form className="follow-up-form" onSubmit={submitFollowUp}>
              <div className="follow-up-heading">
                <div><p className="eyebrow">Confirmation</p><h3>Schedule follow-up</h3></div>
                <button type="button" onClick={() => setScheduling(false)}>Cancel</button>
              </div>
              <label>
                Date and time
                <input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} required />
              </label>
              <label>
                Note <span>optional</span>
                <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="What should the broker do?" rows={2} />
              </label>
              <p>This will ask the agent to update lead {lead.id} in the CRM.</p>
              {formError ? <p className="form-error" role="alert">{formError}</p> : null}
              <button className="confirm-action" type="submit" disabled={disabled}>Confirm follow-up</button>
            </form>
          ) : (
            <button className="primary-action" type="button" onClick={openScheduler} disabled={disabled}>
              Schedule follow-up
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}
