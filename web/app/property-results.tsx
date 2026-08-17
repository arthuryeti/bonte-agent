"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PropertyListView, PropertyView } from "./chat-types";

interface PropertyResultsProps {
  data: PropertyListView;
  onSelect: (property: PropertyView) => void;
}

interface PropertyDrawerProps {
  property: PropertyView;
  disabled: boolean;
  onClose: () => void;
  onRefresh: (property: PropertyView) => void;
}

const PROPERTY_PREVIEW_LIMIT = 3;
const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : value;
}

function formatPrice(value?: string, currency = "EUR"): string | undefined {
  if (!value) return undefined;
  const number = Number(value.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return value;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(number);
  } catch {
    return value;
  }
}

function formatArea(value?: string): string | undefined {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toLocaleString("en-GB")} m²` : value;
}

function propertyStatus(property: PropertyView): string | undefined {
  if (property.sold) return "Sold";
  return property.status;
}

function propertyMeta(property: PropertyView): string[] {
  return [
    property.propertyType,
    property.typology,
    property.location || property.address,
    property.bedrooms !== undefined
      ? `${property.bedrooms} ${property.bedrooms === 1 ? "bed" : "beds"}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
}

export function PropertyResults({ data, onSelect }: PropertyResultsProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  if (data.properties.length === 0) {
    return (
      <section className="lead-results lead-results-empty" aria-label="Property results">
        <p>No matching properties were returned by the CRM.</p>
      </section>
    );
  }

  const canExpand = data.properties.length > PROPERTY_PREVIEW_LIMIT;
  const visibleProperties = expanded
    ? data.properties
    : data.properties.slice(0, PROPERTY_PREVIEW_LIMIT);
  const hiddenCount = data.properties.length - visibleProperties.length;

  return (
    <section className="lead-results property-results" aria-label="Property results">
      <div className="lead-results-head">
        <div>
          <p className="eyebrow">CRM result</p>
          <h2>
            {data.returnedRecords} {data.returnedRecords === 1 ? "property" : "properties"}
          </h2>
        </div>
        <span className="lead-results-total">
          {data.totalRecords > data.returnedRecords
            ? `${data.totalRecords.toLocaleString("en-GB")} total`
            : "Live"}
        </span>
      </div>

      <div className="lead-list" id={listId}>
        {visibleProperties.map((property) => {
          const price = property.priceVisible === false
            ? undefined
            : formatPrice(property.price, property.currency);
          const status = propertyStatus(property);
          return (
            <button
              className="lead-row property-row"
              key={property.id}
              type="button"
              onClick={() => onSelect(property)}
              aria-label={`View property ${property.reference}`}
            >
              <span className="lead-primary">
                <span className="lead-name-line">
                  <strong>{property.reference}</strong>
                  {status ? <span className="status-pill">{status}</span> : null}
                </span>
                <span className="lead-meta">
                  {propertyMeta(property).map((item, index) => (
                    <span key={`${item}-${index}`}>{item}</span>
                  ))}
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
            {expanded ? "Collapse list" : `Show ${hiddenCount} more`}
          </button>
          {expanded && data.truncated ? (
            <span>Refine your request to narrow the full result set.</span>
          ) : null}
        </div>
      ) : data.truncated ? (
        <p className="lead-results-foot">Refine your request to narrow the full result set.</p>
      ) : null}
    </section>
  );
}

export function PropertyDrawer({
  property,
  disabled,
  onClose,
  onRefresh,
}: PropertyDrawerProps) {
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const price = property.priceVisible === false
    ? undefined
    : formatPrice(property.price, property.currency);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const copyPropertyId = async () => {
    try {
      await navigator.clipboard.writeText(property.id);
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
        className="lead-drawer property-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="property-drawer-title"
      >
        <header className="drawer-header">
          <div className="drawer-person">
            <span className="drawer-avatar" aria-hidden="true">P</span>
            <div>
              <p className="eyebrow">Property details</p>
              <h2 id="property-drawer-title">{property.reference}</h2>
              <p>{property.title}</p>
            </div>
          </div>
          <button
            ref={closeRef}
            className="drawer-close"
            type="button"
            onClick={onClose}
            aria-label="Close property details"
          >
            ×
          </button>
        </header>

        <div className="drawer-scroll">
          <div className="drawer-summary">
            {propertyStatus(property) ? <span className="status-pill">{propertyStatus(property)}</span> : null}
            {property.businessType ? <span className="plain-pill">{property.businessType}</span> : null}
            {property.propertyType ? <span className="plain-pill">{property.propertyType}</span> : null}
          </div>

          <section className="drawer-section">
            <div className="section-title">
              <h3>Overview</h3>
              <button type="button" onClick={copyPropertyId}>
                {copied ? "Copied" : "Copy property ID"}
              </button>
            </div>
            <dl className="detail-grid property-detail-grid">
              <div><dt>Price</dt><dd>{price || "Not available"}</dd></div>
              <div><dt>Typology</dt><dd>{property.typology || "Not available"}</dd></div>
              <div><dt>Bedrooms</dt><dd>{property.bedrooms ?? "Not available"}</dd></div>
              <div><dt>Bathrooms</dt><dd>{property.bathrooms ?? "Not available"}</dd></div>
              <div><dt>Living area</dt><dd>{formatArea(property.livingArea) || "Not available"}</dd></div>
              <div><dt>Total area</dt><dd>{formatArea(property.totalArea) || "Not available"}</dd></div>
              <div><dt>Condition</dt><dd>{property.condition || "Not available"}</dd></div>
              <div><dt>Energy rating</dt><dd>{property.energyRating || "Not available"}</dd></div>
            </dl>
          </section>

          <section className="drawer-section">
            <div className="section-title"><h3>Location</h3></div>
            <p className="property-copy">
              {property.address || property.location || "Location not available"}
            </p>
          </section>

          {property.description ? (
            <section className="drawer-section">
              <div className="section-title"><h3>Description</h3></div>
              <p className="property-copy">{property.description}</p>
            </section>
          ) : null}

          {property.agent ? (
            <section className="drawer-section">
              <div className="section-title"><h3>Listing agent</h3></div>
              <dl className="detail-grid">
                <div><dt>Name</dt><dd>{property.agent.name || "Not available"}</dd></div>
                <div><dt>Email</dt><dd>{property.agent.email || "Not available"}</dd></div>
              </dl>
            </section>
          ) : null}

          {property.features.length > 0 ? (
            <section className="drawer-section">
              <div className="section-title"><h3>Features</h3><span>{property.features.length}</span></div>
              <div className="property-features">
                {property.features.map((feature, index) => (
                  <span key={`${feature}-${index}`}>{feature}</span>
                ))}
              </div>
            </section>
          ) : null}

          {property.updatedAt ? (
            <p className="property-updated">Updated {formatDate(property.updatedAt)}</p>
          ) : null}
        </div>

        <footer className="drawer-footer">
          <button
            className="primary-action"
            type="button"
            onClick={() => onRefresh(property)}
            disabled={disabled}
          >
            Fetch latest details from CRM
          </button>
        </footer>
      </aside>
    </div>
  );
}
