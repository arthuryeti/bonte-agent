"use client";

import { useRef, useState, type ReactNode } from "react";
import { makeAssistantDataUI, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowLeftIcon, Building2Icon, ChevronRightIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatCrmDate, formatCrmPrice, safeCrmUrl, useCrmDetails } from "@/app/crm-details";
import type { LeadListView, LeadView, PropertyListView, PropertyView } from "@/app/chat-types";

type Selection = { type: "lead" | "property"; id: string; reference?: string; title: string };

export const PropertyResultsUI = makeAssistantDataUI<PropertyListView>({
  name: "property-list",
  render: ({ data }) => data.buyerSearch ? <BuyerMatches key={`${data.buyerSearch.runId}:${data.buyerSearch.page}:${data.buyerSearch.selectedIds.join(",")}`} data={data} /> : <CrmResults data={data} />,
});

export const LeadResultsUI = makeAssistantDataUI<LeadListView>({
  name: "lead-list",
  render: ({ data }) => <CrmResults data={data} />,
});

function Badge({ children }: { children: ReactNode }) {
  return <span className="inline-flex max-w-full rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-foreground">{children}</span>;
}

export function CrmResults({ data }: { data: PropertyListView | LeadListView }) {
  const [selected, setSelected] = useState<Selection | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const isPropertyList = "properties" in data;
  const records = isPropertyList ? data.properties : data.leads;
  const label = isPropertyList ? "Properties" : "Leads";

  return (
    <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
      <section aria-label={`${label} results`} className="my-4 overflow-hidden rounded-xl border bg-card text-sm leading-normal">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="font-semibold">{label} <span className="ml-1 font-normal text-muted-foreground">{records.length} of {data.totalRecords}</span></h2>
          <span className="text-xs text-muted-foreground">Select a row for details</span>
        </header>
        {records.length === 0 ? <p className="p-4 text-muted-foreground">No matching {label.toLowerCase()} were returned.</p> : (
          <table className="w-full table-fixed text-left">
            <caption className="sr-only">{label} from the CRM. Open a record to fetch its full details.</caption>
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="w-[58%] px-4 py-2 font-medium sm:w-[48%]">{isPropertyList ? "Property" : "Lead"}</th>
                <th scope="col" className={`px-3 py-2 font-medium ${isPropertyList ? "text-right" : "hidden sm:table-cell"}`}>{isPropertyList ? "Price" : "Contact"}</th>
                <th scope="col" className={`w-[24%] px-4 py-2 font-medium ${isPropertyList ? "hidden sm:table-cell" : ""}`}>Status</th>
                <th scope="col" className="w-7"><span className="sr-only">Details</span></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {records.map((record) => {
                const property = "reference" in record ? record : undefined;
                const lead = property ? undefined : record as LeadView;
                const name = lead?.contact?.name || record.title;
                const contact = lead?.contact?.email || lead?.contact?.phone;
                const selection: Selection = { type: property ? "property" : "lead", id: record.id, reference: property?.reference, title: name };
                return (
                  <tr key={record.id} className="cursor-pointer transition-colors hover:bg-accent/60 focus-within:bg-accent/60" onClick={(event) => {
                    trigger.current = event.currentTarget.querySelector("button");
                    setSelected(selection);
                  }}>
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      <div className="flex items-center gap-3">
                        {property ? <PropertyPhoto property={property} thumbnail /> : (
                          <span aria-hidden="true" className="hidden size-9 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-primary sm:flex">
                            {name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}
                          </span>
                        )}
                        <div className="min-w-0">
                          <button type="button" aria-haspopup="dialog" aria-label={`View ${selection.type} ${name}${property ? ` (${property.reference})` : ""}`} className="block w-full cursor-pointer rounded text-left font-medium text-foreground outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
                            <span className="line-clamp-2 break-words">{name}</span>
                          </button>
                          <p className="mt-1 truncate text-xs text-muted-foreground">{property ? property.reference : lead?.title !== name ? lead?.title : `Lead ${record.id}`}</p>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{property ? property.location || property.address || "Location not provided" : lead?.agents.map((agent) => agent.name).join(", ") || "Unassigned"}</p>
                          {property ? <p className="mt-1 text-xs text-muted-foreground">{[
                            property.typology || (property.bedrooms != null ? `${property.bedrooms} beds` : undefined),
                            property.livingArea ? `${property.livingArea} m²` : undefined,
                          ].filter(Boolean).join(" · ")}</p> : <p className="mt-1 break-all text-xs text-muted-foreground sm:hidden">{contact}</p>}
                          {property?.status ? <span className="mt-1 block text-xs text-muted-foreground sm:hidden">{property.status}</span> : null}
                        </div>
                      </div>
                    </th>
                    <td className={`px-3 py-3 align-middle ${property ? "text-right font-medium tabular-nums" : "hidden sm:table-cell"}`}>
                      {property ? <span className="break-words">{formatCrmPrice(property.price, property.currency, property.priceVisible)}</span> : <>
                        <p className="break-all text-xs">{lead?.contact?.email || "Email not provided"}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{lead?.contact?.phone || "Phone not provided"}</p>
                      </>}
                    </td>
                    <td className={`px-4 py-3 ${property ? "hidden sm:table-cell" : ""}`}>
                      <Badge>{record.status || (property?.sold ? "Sold" : "Not provided")}</Badge>
                      {property?.businessType || lead?.priority ? <p className="mt-1 text-xs text-muted-foreground">{property?.businessType || `${lead?.priority} priority`}</p> : null}
                    </td>
                    <td className="pr-3 text-muted-foreground"><ChevronRightIcon aria-hidden="true" className="size-4" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {data.truncated ? <p className="border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground">More matches are available. Refine your request to narrow the results.</p> : null}
      </section>
      {selected ? <RecordPanel initial={selected} onClose={() => setSelected(null)} onReturnFocus={() => trigger.current?.focus()} /> : null}
    </Dialog>
  );
}

function RecordPanel({ initial, onClose, onReturnFocus }: { initial: Selection; onClose: () => void; onReturnFocus: () => void }) {
  const aui = useAui();
  const busy = useAuiState(s => s.thread.isRunning || s.thread.isDisabled);
  const [selection, setSelection] = useState(initial);
  const { data, loading, error, refresh } = useCrmDetails(selection.type, selection.id, selection.reference);
  const record = data?.[selection.type];
  const listingUrl = safeCrmUrl(data?.property?.listingUrl, true);

  return (
    <DialogContent className="inset-y-0 right-0 left-auto flex h-dvh w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 p-0 sm:max-w-xl data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100 motion-reduce:animate-none" onCloseAutoFocus={(event) => { event.preventDefault(); onReturnFocus(); }}>
      <header className="shrink-0 border-b p-5 pr-12">
        {selection !== initial ? <Button variant="ghost" size="sm" className="mb-3 -ml-2" onClick={() => setSelection(initial)}><ArrowLeftIcon />Back to lead</Button> : null}
        <p className="mb-2 text-xs font-medium uppercase tracking-widest text-primary">{selection.type === "property" ? "Property details" : "Lead details"}</p>
        <DialogTitle className="break-words text-xl leading-snug">{data?.lead?.contact?.name || record?.title || selection.title}</DialogTitle>
        <DialogDescription className="mt-2">{selection.type === "property" ? data?.property?.reference || selection.reference || selection.id : `Lead ${selection.id}`}</DialogDescription>
      </header>
      <div key={`${selection.type}:${selection.id}:${selection.reference}`} className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-5" aria-busy={loading}>
        {loading ? <div role="status" className="space-y-4 text-sm text-muted-foreground"><p>Loading fresh CRM details…</p><div className="h-40 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" /><div className="h-16 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" /></div> : null}
        {error ? <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</div> : null}
        {data?.property ? <PropertyDetails property={data.property} /> : null}
        {data?.lead ? <LeadDetails lead={data.lead} onSelectProperty={setSelection} /> : null}
        {data?.warnings?.length ? <details className="rounded-lg border p-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">Data availability · {data.warnings.length} {data.warnings.length === 1 ? "note" : "notes"}</summary><ul className="mt-3 list-disc space-y-2 pl-4">{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
      </div>
      <footer className="shrink-0 space-y-3 border-t bg-background p-4">
        {data?.lead ? <Button className="w-full" disabled={busy || loading} onClick={() => {
          onClose();
          aui.thread.append({ role: "user", content: [{ type: "text", text: `Match properties across CRM and Idealista for lead ID ${JSON.stringify(data.lead!.id)}. Use their saved buyer brief; ask only for missing or ambiguous requirements.` }] });
        }}><Building2Icon />Match properties</Button> : null}
        {selection.type === "property" && data?.property ? listingUrl ? (
          <Button asChild className="w-full"><a href={listingUrl} target="_blank" rel="noopener noreferrer">View on Bonte Filipidis<ExternalLinkIcon /></a></Button>
        ) : <p className="text-center text-xs text-muted-foreground">Website listing unavailable for this property.</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{data ? `Fetched ${formatCrmDate(data.fetchedAt)}` : "CRM details"}</p>
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}><RefreshCwIcon className={loading ? "animate-spin motion-reduce:animate-none" : ""} />{error ? "Retry" : "Refresh"}</Button>
        </div>
      </footer>
    </DialogContent>
  );
}

function BuyerMatches({ data }: { data: PropertyListView }) {
  const search = data.buyerSearch!;
  const aui = useAui();
  const busy = useAuiState(s => s.thread.isRunning || s.thread.isDisabled);
  const [selected, setSelected] = useState<string[]>(search.selectedIds);
  const send = (text: string) => aui.thread.append({ role: "user", content: [{ type: "text", text }] });
  const page = (value: number) => send(`Show saved buyer matching results with get_buyer_matches: ${JSON.stringify({ runId: search.runId, page: value, selectedIds: selected })}. Browse the saved results without repeating the search.`);
  const select = (id: string, checked: boolean) => setSelected(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id));
  return <section aria-label={`Property matches for ${search.name}`} className="my-4 space-y-4 rounded-xl border bg-card p-4 text-sm leading-normal">
    <header className="space-y-2">
      <h2 className="text-lg font-semibold">Matches for {search.name}</h2>
      <p className="text-muted-foreground">{search.exactCount} match the requirements · {search.unverifiedCount} need verification</p>
      <p className="text-xs text-muted-foreground">Searched {formatCrmDate(search.fetchedAt)}. Availability must be confirmed with the listing agent.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => send(`Edit the requirements for saved buyer brief ${JSON.stringify(search.briefId)}. Show the current requirements and ask what I want to change before searching again.`)}>Edit requirements</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => send(`Refresh buyer matching across CRM and Idealista for ${JSON.stringify({ briefId: search.briefId, maxPages: search.maxPages })}. This is a new search; keep previous shortlists saved.`)}><RefreshCwIcon />Refresh matches</Button>
      </div>
    </header>
    <div className="rounded-lg bg-muted/40 p-3 text-xs">
      {search.coverage.map((source, index) => <div key={index} className="mb-2 last:mb-0">
        <p><strong>{source.source}</strong>: {source.fetchedRecords} listings checked{source.totalRecords !== undefined ? ` of ${source.totalRecords} reported` : ""} · {source.complete ? "Search complete" : "Partial search"}</p>
        {source.warnings.map((warning, i) => <p key={i} className="mt-1 text-muted-foreground">{warning}</p>)}
      </div>)}
    </div>
    {(["exact", "unverified"] as const).map(status => {
      const properties = data.properties.filter(p => p.matchStatus === status);
      return properties.length ? <section key={status} className="space-y-3" aria-label={status === "exact" ? "Matching properties" : "Properties needing verification"}>
        <h3 className="font-semibold">{status === "exact" ? "Matching properties" : "Needs verification"}</h3>
        {properties.map(property => <article key={property.id} className="space-y-3 rounded-lg border p-3">
          <div className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" aria-label={`Select ${property.title} (${property.reference})`} checked={selected.includes(property.id)} disabled={busy || (!selected.includes(property.id) && selected.length >= 20)} onChange={e => select(property.id, e.target.checked)} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">{property.title}</h4><Badge>{property.source === "idealista" ? "Idealista" : "CRM"}</Badge></div>
              <p className="mt-1 text-xs text-muted-foreground">{property.reference} · {property.location || "Location not provided"}</p>
              <p className="mt-2 font-semibold">{formatCrmPrice(property.price, property.currency, property.priceVisible)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{[
                property.bedrooms !== undefined ? `${property.bedrooms} bedrooms` : "Bedrooms unknown",
                property.builtArea ? `${property.builtArea} m² built` : undefined,
                property.livingArea ? `${property.livingArea} m² living` : undefined,
                property.totalArea ? `${property.totalArea} m² total` : undefined,
              ].filter(Boolean).join(" · ")}</p>
            </div>
          </div>
          <PropertyPhoto property={property} />
          {property.matchReasons?.length ? <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{property.matchReasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul> : <p className="text-xs text-muted-foreground">Meets the saved mandatory requirements.</p>}
          <div className="flex flex-wrap gap-3">{property.sourceLinks?.map(link => <a key={`${link.source}:${link.url}`} href={safeCrmUrl(link.url)} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline underline-offset-4">View {link.source} listing</a>)}</div>
        </article>)}
      </section> : null;
    })}
    {!data.properties.length ? <p className="text-muted-foreground">No properties matched the verified requirements in the searched listings.</p> : null}
    <footer className="space-y-3 border-t pt-3">
      <div className="flex items-center justify-between gap-2"><Button variant="outline" size="sm" disabled={busy || search.page <= 1} onClick={() => page(search.page - 1)}>Previous</Button><span className="text-xs">Page {search.page} of {search.pages}</span><Button variant="outline" size="sm" disabled={busy || search.page >= search.pages} onClick={() => page(search.page + 1)}>Next</Button></div>
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{selected.length} of 20 selected · selections carry across pages</p><Button disabled={busy || !selected.length} onClick={() => send(`Prepare a buyer shortlist and email draft using precisely this selection: ${JSON.stringify({ runId: search.runId, selectedIds: selected })}. Refresh selected listings, report any changes, and do not send.`)}>Prepare shortlist</Button></div>
    </footer>
  </section>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0"><h3 className="text-sm font-semibold">{title}</h3>{children}</section>;
}

function Fields({ values }: { values: [string, ReactNode][] }) {
  return <dl className="grid grid-cols-2 gap-x-5 gap-y-4 text-sm">{values.map(([label, value]) => <div key={label} className="min-w-0"><dt className="mb-1 text-xs text-muted-foreground">{label}</dt><dd className="break-words">{value === undefined || value === null || value === "" ? "Not provided" : value}</dd></div>)}</dl>;
}

function PropertyPhoto({ property, thumbnail = false }: { property: PropertyView; thumbnail?: boolean }) {
  const url = safeCrmUrl(property.photoUrl);
  const [failed, setFailed] = useState("");
  const hasPhoto = url && failed !== url;
  return <div className={`${thumbnail ? "hidden size-12 shrink-0 sm:flex" : hasPhoto ? "flex aspect-[16/10] max-h-60 w-full" : "flex h-16 gap-2 text-xs"} items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground`}>
    {hasPhoto ? <img src={url} alt={thumbnail ? "" : property.title} loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFailed(url)} /> : <><Building2Icon aria-hidden="true" className="size-5" />{!thumbnail ? "Photo unavailable" : null}</>}
  </div>;
}

function PropertyDetails({ property }: { property: PropertyView }) {
  const area = (value?: string) => value ? `${value} m²` : undefined;
  const yesNo = (value?: boolean) => value == null ? undefined : value ? "Yes" : "No";
  return <>
    <PropertyPhoto property={property} />
    <div>
      <div className="flex flex-wrap gap-2">{[property.status, property.businessType, property.propertyType].filter(Boolean).map((value, index) => <Badge key={index}>{value}</Badge>)}</div>
      <p className="mt-3 text-2xl font-semibold tabular-nums">{formatCrmPrice(property.price, property.currency, property.priceVisible)}</p>
      <p className="mt-2 text-sm text-muted-foreground">{property.location || property.address || "Location not provided"}</p>
    </div>
    <Section title="At a glance"><Fields values={[
      ["Bedrooms", property.bedrooms], ["Bathrooms", property.bathrooms],
      ["Living area", area(property.livingArea)], ["Total area", area(property.totalArea)],
      ["Plot area", area(property.plotArea)], ["Typology", property.typology],
      ["Condition", property.condition], ["Energy rating", property.energyRating],
    ]} /></Section>
    <Section title="Description"><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{property.description || "No description provided."}</p></Section>
    <Section title="Features">{property.features.length ? <ul className="flex flex-wrap gap-2">{property.features.map((feature, index) => <li key={index}><Badge>{feature}</Badge></li>)}</ul> : <p className="text-sm text-muted-foreground">No features provided.</p>}</Section>
    <Section title="Listing information"><Fields values={[
      ["Reference", property.reference], ["CRM ID", property.id],
      ...(property.internalId ? [["Internal ID", property.internalId] as [string, ReactNode]] : []),
      ["Address", property.address], ["Location", property.location],
      ["Published on website", yesNo(property.visibleOnWebsite)], ["Sold", yesNo(property.sold)],
      ["Price visible", yesNo(property.priceVisible)], ["Currency", property.currency],
      ["Created", formatCrmDate(property.createdAt)], ["Updated", formatCrmDate(property.updatedAt)],
    ]} /></Section>
    <Section title="Listing agent"><Fields values={[
      ["Name", property.agent?.name], ["Email", property.agent?.email], ["Phone", property.agent?.phone],
    ]} /></Section>
  </>;
}

function LeadDetails({ lead, onSelectProperty }: { lead: LeadView; onSelectProperty: (selection: Selection) => void }) {
  const crmUrl = safeCrmUrl(lead.crmUrl);
  return <>
    <div className="flex flex-wrap gap-2">{[lead.status, lead.priority ? `${lead.priority} priority` : undefined, lead.origin].filter(Boolean).map((value, index) => <Badge key={index}>{value}</Badge>)}</div>
    <Section title="Contact"><Fields values={[
      ["Name", lead.contact?.name], ["Language", lead.contact?.language],
      ["Email", lead.contact?.email ? <a className="text-primary underline underline-offset-4" href={`mailto:${encodeURIComponent(lead.contact.email)}`}>{lead.contact.email}</a> : undefined],
      ["Phone", lead.contact?.phone ? <a className="text-primary underline underline-offset-4" href={`tel:${lead.contact.phone.replace(/[^\d+]/g, "")}`}>{lead.contact.phone}</a> : undefined],
      ["Assigned to", lead.agents.map((agent) => agent.name).join(", ") || "Unassigned"],
    ]} />{crmUrl ? <Button asChild variant="outline" size="sm"><a href={crmUrl} target="_blank" rel="noopener noreferrer">Open CRM<ExternalLinkIcon /></a></Button> : null}</Section>
    <Section title="Lead information"><Fields values={[
      ["Title", lead.title], ["Lead ID", lead.id], ["Source", lead.origin], ["Priority", lead.priority],
      ["Outcome", lead.outcome], ["Outcome date", formatCrmDate(lead.outcomeDate)],
      ["Sale price", formatCrmPrice(lead.salePrice)], ["Created", formatCrmDate(lead.createdAt)],
      ["Updated", formatCrmDate(lead.updatedAt)],
    ]} /></Section>
    <Section title="Notes"><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{lead.description || "No notes provided."}</p></Section>
    <Section title={`Related properties · ${lead.propertyCount}`}>
      {lead.properties.length ? <ul className="divide-y rounded-lg border">{lead.properties.map((property, index) => <li key={`${property.id || property.reference}:${index}`}>
        <button type="button" className="flex w-full items-center justify-between gap-3 p-3 text-left text-sm hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60" disabled={!property.id && !property.reference} onClick={() => onSelectProperty({ type: "property", id: property.id || "", reference: property.reference, title: property.title || property.reference || `Property ${property.id}` })}>
          <span className="min-w-0"><span className="block font-medium">{property.title || property.reference || `Property ${property.id || index + 1}`}</span><span className="mt-1 block text-xs text-muted-foreground">{[property.reference, property.address].filter(Boolean).join(" · ")}</span>{property.price ? <span className="mt-1 block text-xs">{formatCrmPrice(property.price)}</span> : null}</span>
          <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </li>)}</ul> : <p className="text-sm text-muted-foreground">No related properties returned.</p>}
    </Section>
    <Section title={`Activity · ${lead.eventCount}`}>
      {lead.events.length ? <ol className="ml-1 space-y-5 border-l pl-4">{lead.events.map((event, index) => <li key={`${event.id || event.title}:${index}`} className="relative text-sm">
        <span aria-hidden="true" className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-primary" />
        <p className="font-medium">{event.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{[event.type, event.location].filter(Boolean).join(" · ")}</p>
        {event.startsAt ? <p className="mt-1 text-xs text-muted-foreground">{formatCrmDate(event.startsAt)}{event.endsAt ? ` – ${formatCrmDate(event.endsAt)}` : ""}</p> : null}
        {event.description ? <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{event.description}</p> : null}
      </li>)}</ol> : <p className="text-sm text-muted-foreground">No activity returned by the CRM.</p>}
    </Section>
  </>;
}
