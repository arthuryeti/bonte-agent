import { tool } from "@langchain/core/tools";
import * as z from "zod";
import {
  callCrmApi,
  callCrmApiWithPagination,
} from "../client/crm-client.js";

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
  if (endpoint === "/api/Leads/List") {
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

      return JSON.stringify(response.data);
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
    }),
  }
);
