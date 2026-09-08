"use client";

import { useEffect, useState } from "react";
import type { LeadView, PropertyView } from "./chat-types";

interface CrmDetails {
  lead?: LeadView;
  property?: PropertyView;
  fetchedAt: string;
  warnings?: string[];
}

export function useCrmDetails(type: "lead" | "property", id = "", reference = "") {
  const [revision, setRevision] = useState(0);
  const query = new URLSearchParams({ type });
  if (id && (type === "lead" || (id !== reference && /^[1-9]\d*$/.test(id)))) query.set("id", id);
  if (type === "property" && reference) query.set("reference", reference);
  const url = `/api/crm?${query}`;
  const key = `${url}:${revision}`;
  const [state, setState] = useState<{ key: string; data?: CrmDetails; error?: string }>();

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 404
          ? "This record is no longer available in the CRM."
          : response.status === 401 ? "Sign in again to load CRM details."
            : "CRM details could not be loaded. Please try again.");
        const data = await response.json() as CrmDetails;
        const record = data?.[type];
        if (!record || typeof record.id !== "string" || typeof record.title !== "string"
          || typeof data.fetchedAt !== "string" || !Number.isFinite(Date.parse(data.fetchedAt))
          || (type === "lead" && (!Array.isArray(data.lead?.agents) || !Array.isArray(data.lead?.properties) || !Array.isArray(data.lead?.events)))
          || (type === "property" && (typeof data.property?.reference !== "string" || !Array.isArray(data.property?.features)))
          || (data.warnings !== undefined && (!Array.isArray(data.warnings) || !data.warnings.every((warning) => typeof warning === "string")))) {
          throw new Error("The CRM returned incomplete details. Please try again.");
        }
        if (data.property?.listingUrl) {
          try {
            const listing = new URL(data.property.listingUrl);
            if (listing.protocol !== "https:" || !["bontefilipidis.com", "www.bontefilipidis.com"].includes(listing.hostname)
              || listing.username || listing.password) data.property.listingUrl = undefined;
          } catch { data.property.listingUrl = undefined; }
        }
        if (!controller.signal.aborted) setState({ key, data });
      } catch (error) {
        if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : "CRM details could not be loaded." });
      }
    })();
    return () => controller.abort();
  }, [key, type, url]);

  const current = state?.key === key ? state : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: !current,
    refresh: () => setRevision((value) => value + 1),
  };
}
