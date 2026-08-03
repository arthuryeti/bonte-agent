import { tool } from "@langchain/core/tools";
import * as z from "zod";
import {
  callCrmApi,
  callCrmApiWithPagination,
} from "../client/crm-client.js";

const LEADS_LIST_ENDPOINT = "/api/Leads/List";
const DEFAULT_LEAD_RESULT_LIMIT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRecords(
  left: unknown,
  right: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(isRecord(left) ? left : {}),
    ...right,
  };
}

function mergeFiltersIntoBody(
  endpoint: string,
  body: Record<string, unknown> | undefined,
  filters: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (endpoint === LEADS_LIST_ENDPOINT) {
    return {
      Language: "en",
      ...(body ?? {}),
      ...(filters ?? {}),
    };
  }

  if (!filters || Object.keys(filters).length === 0) {
    return body;
  }

  const nextBody = { ...(body ?? {}) };

  switch (endpoint) {
    case "/api/Agency/GetAgencies":
      nextBody.AgencySearchFilters = mergeRecords(
        nextBody.AgencySearchFilters,
        filters
      );
      return nextBody;

    case "/api/Entity/GetAgents":
      nextBody.EntitySearchFilters = mergeRecords(
        nextBody.EntitySearchFilters,
        filters
      );
      return nextBody;

    default:
      return {
        ...nextBody,
        ...filters,
      };
  }
}

type LeadSortField = "CreateDate" | "LastUpdate";
type SortDirection = "asc" | "desc";
type LeadResultDetail = "summary" | "full";

interface LeadResultOptions {
  resultLimit?: number;
  resultSortBy?: LeadSortField;
  resultSortDirection?: SortDirection;
  resultDetail?: LeadResultDetail;
}

function copyFields(
  source: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => source[field] !== undefined && source[field] !== null)
      .map((field) => [field, source[field]])
  );
}

function summarizeRecords(
  value: unknown,
  fields: readonly string[],
  limit: number
): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(0, limit).map((item) => copyFields(item, fields));
}

function summarizeLead(lead: Record<string, unknown>): Record<string, unknown> {
  const summary = copyFields(lead, [
    "Id",
    "Title",
    "CurrentStatus",
    "CreateDate",
    "LastUpdate",
    "Origin",
    "Outcome",
    "OutcomeDate",
    "EventPriority",
    "EventType",
    "SalePrice",
  ]);

  const agents = Array.isArray(lead.Agents) ? lead.Agents.filter(isRecord) : [];
  const properties = Array.isArray(lead.Properties)
    ? lead.Properties.filter(isRecord)
    : [];
  const events = Array.isArray(lead.Events) ? lead.Events.filter(isRecord) : [];

  if (agents.length > 0) {
    summary.Agents = summarizeRecords(
      agents,
      ["AgentID", "AgentName"],
      5
    );
    summary.AgentCount = agents.length;
  }

  if (properties.length > 0) {
    summary.Properties = summarizeRecords(
      properties,
      ["PropertyID", "Reference", "Address", "Price", "LastUpdate"],
      5
    );
    summary.PropertyCount = properties.length;
  }

  if (isRecord(lead.Customer)) {
    summary.Customer = copyFields(lead.Customer, [
      "Name",
      "EmailAddress",
      "PhoneNumber",
      "Language",
    ]);
  }

  if (events.length > 0) {
    const recentEvents = [...events]
      .sort((left, right) =>
        compareLeadDates(left, right, "LastUpdate", "desc") ||
        compareLeadDates(left, right, "CreateDate", "desc") ||
        compareEventDates(left, right)
      )
      .slice(0, 3);
    summary.Events = summarizeRecords(
      recentEvents,
      ["EventID", "EventType", "EventTypeID", "Title", "Location", "StartDate", "EndDate"],
      3
    );
    summary.EventCount = events.length;
  }

  return summary;
}

function compareEventDates(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): number {
  const readTime = (record: Record<string, unknown>): number => {
    for (const field of ["StartDate", "EndDate"]) {
      if (typeof record[field] !== "string") continue;
      const parsed = Date.parse(record[field]);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Number.NEGATIVE_INFINITY;
  };

  return readTime(right) - readTime(left);
}

function compareLeadDates(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  field: LeadSortField,
  direction: SortDirection
): number {
  const leftTime =
    typeof left[field] === "string" ? Date.parse(left[field]) : Number.NaN;
  const rightTime =
    typeof right[field] === "string" ? Date.parse(right[field]) : Number.NaN;
  const leftIsValid = Number.isFinite(leftTime);
  const rightIsValid = Number.isFinite(rightTime);

  // Keep records without a usable date at the end in either direction.
  if (!leftIsValid && !rightIsValid) return 0;
  if (!leftIsValid) return 1;
  if (!rightIsValid) return -1;

  return direction === "asc" ? leftTime - rightTime : rightTime - leftTime;
}

/**
 * The leads endpoint has no server-side pagination and can return several MB.
 * Bound and order the result before it enters the model context.
 */
export function shapeLeadListResult(
  data: unknown,
  options: LeadResultOptions = {}
): unknown {
  if (!isRecord(data) || !Array.isArray(data.Opportunities)) {
    return data;
  }

  const sortBy = options.resultSortBy ?? "CreateDate";
  const sortDirection = options.resultSortDirection ?? "desc";
  const detail = options.resultDetail ?? "summary";
  const limit = options.resultLimit ?? DEFAULT_LEAD_RESULT_LIMIT;
  const opportunities = data.Opportunities.filter(isRecord);
  const selected = [...opportunities]
    .sort((left, right) =>
      compareLeadDates(left, right, sortBy, sortDirection)
    )
    .slice(0, limit)
    .map((lead) => (detail === "full" ? lead : summarizeLead(lead)));

  return {
    ...data,
    Opportunities: selected,
    _result: {
      totalRecords: opportunities.length,
      returnedRecords: selected.length,
      limit,
      sortBy,
      sortDirection,
      detail,
      truncated: selected.length < opportunities.length,
    },
  };
}

/**
 * Single tool that exposes the entire Proppy CRM API to the agent.
 *
 * Available endpoints (from swagger spec):
 * - POST /api/Agency/GetAgencies            – Get Agencies
 * - POST /api/CasafariGo/GetUrl             – Get CasafariGo Url
 * - POST /api/CasafariGo/CreateUser         – Create CasafariGo User
 * - POST /api/CasafariGo/DeleteUser         – Delete CasafariGo User
 * - GET  /api/CodeTable                     – Get code tables (business types, property types, zones)
 * - POST /api/Entity/GetAgents              – Get Agents
 * - POST /api/Entity/GetOwnerlinks          – Get Ownerlinks
 * - POST /api/Leads/Insert                  – Insert a lead
 * - POST /api/Leads/List                    – Get Sales/Listings (leads list)
 * - POST /api/Property/SendProperty         – Insert/Update Property
 * - POST /api/Property/DeleteProperty       – Delete Property
 * - POST /api/Property/ListProperties       – Get Property List
 * - POST /api/Property/Location             – Get Locations
 * - POST /api/Property/InnerLocations       – Get InnerLocations
 * - POST /api/Property/Hit                  – Insert Property Visit
 */
export const callCrmApiTool = tool(
  async ({
    endpoint,
    method,
    body,
    filters,
    queryParams,
    autoPaginate,
    pageSize,
    maxPages,
    resultLimit,
    resultSortBy,
    resultSortDirection,
    resultDetail,
  }) => {
    const requestBody = mergeFiltersIntoBody(endpoint, body, filters);
    const request = {
      endpoint,
      method: method as "GET" | "POST",
      body: requestBody,
      queryParams: queryParams ?? undefined,
    };

    try {
      const response =
        autoPaginate ?? true
          ? await callCrmApiWithPagination(request, { pageSize, maxPages })
          : await callCrmApi(request);

      const responseData =
        endpoint === LEADS_LIST_ENDPOINT
          ? shapeLeadListResult(response.data, {
              resultLimit,
              resultSortBy,
              resultSortDirection,
              resultDetail,
            })
          : response.data;

      return JSON.stringify(responseData);
    } catch (error) {
      return JSON.stringify({
        _error: true,
        message:
          error instanceof Error
            ? error.message
            : "Unknown CRM API error",
        endpoint,
        method,
      });
    }
  },
  {
    name: "call_crm_api",
    description:
      "Call the Proppy CRM API. " +
      "Use this tool to interact with the CRM (agencies, entities, leads, properties, code tables). " +
      "Available endpoints:\n" +
      "- POST /api/Agency/GetAgencies – list agencies\n" +
      "- POST /api/CasafariGo/GetUrl – get CasafariGo URL\n" +
      "- POST /api/CasafariGo/CreateUser – create CasafariGo user\n" +
      "- POST /api/CasafariGo/DeleteUser – delete CasafariGo user\n" +
      "- GET  /api/CodeTable – retrieve code tables (business types, property types, zones, languages)\n" +
      "- POST /api/Entity/GetAgents – list agents/entities\n" +
      "- POST /api/Entity/GetOwnerlinks – get owner links\n" +
      "- POST /api/Leads/Insert – create a new lead\n" +
      "- POST /api/Leads/List – list leads (sales/listings)\n" +
      "- POST /api/Property/SendProperty – insert or update a property\n" +
      "- POST /api/Property/DeleteProperty – delete a property\n" +
      "- POST /api/Property/ListProperties – search/list properties\n" +
      "- POST /api/Property/Location – get locations\n" +
      "- POST /api/Property/InnerLocations – get inner locations\n" +
      "- POST /api/Property/Hit – record a property visit/hit\n" +
      "For POST requests, provide the exact request body as a JSON object in 'body'. " +
      "Use 'filters' for end-user search criteria; it is merged into the correct filter object for agencies and agents, and into the top-level body for leads, properties, and other endpoints. " +
      "Supported paginated list endpoints are automatically fetched across all pages by default: /api/Agency/GetAgencies, /api/Entity/GetAgents, /api/Entity/GetOwnerlinks, and /api/Property/ListProperties. " +
      "For properties, filters include Reference, PropertyIds, BusinessTypeIds, PropertyTypeIds, Locations, PriceFrom, PriceTo, MinBedrooms, MaxBedrooms, Active, VisibleOnWebsite, Sold, AgentId, AgencyId, FreeText, and related FilterRq fields. " +
      "For leads, filters include StartDate, EndDate, Category, OriginId, and Language; the API spec does not expose pagination for /api/Leads/List. " +
      "Lead-list results are sorted by CreateDate descending, limited to 20 records, and compacted to useful summary fields by default because the API returns its entire history with large nested event data. Use resultLimit (maximum 100) to request a different bounded count, resultSortBy to sort by CreateDate or LastUpdate, resultSortDirection for newest/oldest ordering, and resultDetail=full only when the user explicitly needs complete nested lead details. The _result metadata reports the full matching count and whether records were truncated. " +
      "For GET requests, provide query parameters in 'queryParams'.",
    schema: z.object({
      endpoint: z
        .string()
        .describe(
          "The API endpoint path, e.g. /api/Leads/List or /api/Property/ListProperties"
        ),
      method: z
        .enum(["GET", "POST"])
        .describe("HTTP method for the endpoint"),
      body: z
        .record(z.any())
        .optional()
        .describe("Exact JSON body for POST requests"),
      filters: z
        .record(z.any())
        .optional()
        .describe(
          "End-user filters to merge into the request. For /api/Agency/GetAgencies these go under AgencySearchFilters; for /api/Entity/GetAgents under EntitySearchFilters; otherwise top-level."
        ),
      queryParams: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Query parameters for GET requests"),
      autoPaginate: z
        .boolean()
        .optional()
        .describe(
          "Defaults to true. When true, fetch every page for supported list endpoints and return a merged result with _pagination metadata."
        ),
      pageSize: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Page size for auto-pagination. Defaults to 100."),
      maxPages: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe(
          "Safety cap for auto-pagination. Defaults to 100 pages; increase only when the user explicitly needs more."
        ),
      resultLimit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe(
          "Maximum lead records returned to the model for /api/Leads/List. Defaults to 20."
        ),
      resultSortBy: z
        .enum(["CreateDate", "LastUpdate"])
        .optional()
        .describe(
          "Lead-list date field used for ordering. Defaults to CreateDate."
        ),
      resultSortDirection: z
        .enum(["asc", "desc"])
        .optional()
        .describe(
          "Lead-list order: desc returns the newest records first (default); asc returns the oldest first."
        ),
      resultDetail: z
        .enum(["summary", "full"])
        .optional()
        .describe(
          "Lead-list detail level. Defaults to summary; use full only when complete nested lead/event details are necessary."
        ),
    }),
  }
);
