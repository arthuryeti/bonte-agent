/**
 * Thin HTTP client for the Proppy CRM API.
 * Base URL: https://crmapi.proppydev.com
 */

export interface CrmRequest {
  endpoint: string;
  method: "GET" | "POST";
  queryParams?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface CrmResponse {
  status: number;
  data: unknown;
}

export interface CrmPaginationOptions {
  pageSize?: number;
  maxPages?: number;
  startPage?: number;
}

export interface CrmPaginatedResponse extends CrmResponse {
  pagination?: {
    autoPaginated: boolean;
    itemKey: string;
    pagesFetched: number;
    pageSize: number;
    startPage: number;
    returnedRecords: number;
    totalPages?: number;
    totalRecords?: number;
    truncated: boolean;
  };
}

const BASE_URL = "https://crmapi.casafaricrm.com";
// const BASE_URL = "https://crmapi.proppydev.com";

type PaginationConfig =
  | {
      strategy: "nested";
      itemKey: string;
      pagingKey: string;
      pageField: string;
      pageSizeField: string;
      responsePagingKey?: string;
      totalRecordsKey?: string;
      defaultPageSize: number;
      maxPageSize: number;
    }
  | {
      strategy: "sequence";
      itemKey: string;
      pageField: string;
      pageSizeField: string;
      totalRecordsKey?: string;
      defaultPageSize: number;
      maxPageSize: number;
    };

const PAGINATED_ENDPOINTS: Record<string, PaginationConfig> = {
  "/api/Agency/GetAgencies": {
    strategy: "nested",
    itemKey: "Agencies",
    pagingKey: "PagingRq",
    pageField: "Current",
    pageSizeField: "ResultsPerPage",
    responsePagingKey: "PagingRs",
    totalRecordsKey: "TotalRecords",
    defaultPageSize: 100,
    maxPageSize: 100,
  },
  "/api/Entity/GetAgents": {
    strategy: "nested",
    itemKey: "Entities",
    pagingKey: "PagingRq",
    pageField: "Current",
    pageSizeField: "ResultsPerPage",
    responsePagingKey: "PagingRs",
    totalRecordsKey: "TotalRecords",
    defaultPageSize: 100,
    maxPageSize: 100,
  },
  "/api/Entity/GetOwnerlinks": {
    strategy: "nested",
    itemKey: "Ownerlinks",
    pagingKey: "PagingRq",
    pageField: "Current",
    pageSizeField: "ResultsPerPage",
    defaultPageSize: 100,
    maxPageSize: 100,
  },
  "/api/Property/ListProperties": {
    strategy: "sequence",
    itemKey: "PropertyList",
    pageField: "SequenceNmbr",
    pageSizeField: "MaxResponses",
    totalRecordsKey: "Count",
    defaultPageSize: 100,
    maxPageSize: 100,
  },
};

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  const apiKey = process.env.CRM_API_KEY;
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }

  const username = process.env.CRM_USERNAME;
  const password = process.env.CRM_PASSWORD;
  if (username && password) {
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    headers["Authorization"] = `Basic ${encoded}`;
  }

  const bearerToken = process.env.CRM_BEARER_TOKEN;
  if (bearerToken) {
    headers["Authorization"] = `Basic ${bearerToken}`;
  }

  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    return {};
  }

  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

function normalizeEndpoint(endpoint: string): string {
  return new URL(endpoint, BASE_URL).pathname;
}

function clampPageSize(pageSize: number, maxPageSize: number): number {
  return Math.max(1, Math.min(Math.floor(pageSize), maxPageSize));
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getItems(data: unknown, itemKey: string): unknown[] {
  if (!isRecord(data)) {
    return [];
  }

  const items = data[itemKey];
  return Array.isArray(items) ? items : [];
}

function getTotalPages(data: unknown, config: PaginationConfig): number | undefined {
  if (
    config.strategy !== "nested" ||
    !config.responsePagingKey ||
    !isRecord(data)
  ) {
    return undefined;
  }

  const paging = data[config.responsePagingKey];
  return isRecord(paging) ? getNumber(paging.TotalPages) : undefined;
}

function getNextPage(data: unknown, config: PaginationConfig): number | undefined {
  if (
    config.strategy !== "nested" ||
    !config.responsePagingKey ||
    !isRecord(data)
  ) {
    return undefined;
  }

  const paging = data[config.responsePagingKey];
  return isRecord(paging) ? getNumber(paging.NextPage) : undefined;
}

function getTotalRecords(data: unknown, config: PaginationConfig): number | undefined {
  if (!config.totalRecordsKey || !isRecord(data)) {
    return undefined;
  }

  return getNumber(data[config.totalRecordsKey]);
}

function withPagination(
  body: unknown,
  config: PaginationConfig,
  page: number,
  pageSize: number
): Record<string, unknown> {
  const nextBody = cloneBody(body);

  if (config.strategy === "nested") {
    const existingPaging = nextBody[config.pagingKey];
    const paging = isRecord(existingPaging) ? { ...existingPaging } : {};
    paging[config.pageField] = page;
    paging[config.pageSizeField] = pageSize;
    nextBody[config.pagingKey] = paging;
  } else {
    nextBody[config.pageField] = page;
    nextBody[config.pageSizeField] = pageSize;
  }

  return nextBody;
}

export async function callCrmApi(request: CrmRequest): Promise<CrmResponse> {
  const url = new URL(request.endpoint, BASE_URL);

  if (request.queryParams) {
    for (const [key, value] of Object.entries(request.queryParams)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...getAuthHeaders(),
  };

  const fetchOptions: RequestInit = {
    method: request.method,
    headers,
  };

  if (request.method === "POST") {
    fetchOptions.body = JSON.stringify(request.body ?? {});
  }

  const response = await fetch(url.toString(), fetchOptions);

  let data: unknown;
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    throw new Error(
      `CRM API error: ${response.status} ${response.statusText}\n${JSON.stringify(data, null, 2)}`
    );
  }

  return { status: response.status, data };
}

export async function callCrmApiWithPagination(
  request: CrmRequest,
  options: CrmPaginationOptions = {}
): Promise<CrmPaginatedResponse> {
  const config = PAGINATED_ENDPOINTS[normalizeEndpoint(request.endpoint)];
  if (!config || request.method !== "POST") {
    return callCrmApi(request);
  }

  const pageSize = clampPageSize(
    options.pageSize ?? config.defaultPageSize,
    config.maxPageSize
  );
  const startPage = Math.max(1, Math.floor(options.startPage ?? 1));
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? 100));

  let page = startPage;
  let status = 200;
  let baseData: Record<string, unknown> | undefined;
  let pagesFetched = 0;
  let totalPages: number | undefined;
  let totalRecords: number | undefined;
  let truncated = false;
  const allItems: unknown[] = [];

  for (let i = 0; i < maxPages; i += 1) {
    const response = await callCrmApi({
      ...request,
      body: withPagination(request.body, config, page, pageSize),
    });

    status = response.status;
    const data = response.data;
    const items = getItems(data, config.itemKey);

    if (!baseData && isRecord(data)) {
      baseData = { ...data };
    }

    pagesFetched += 1;
    allItems.push(...items);

    totalPages = getTotalPages(data, config) ?? totalPages;
    totalRecords = getTotalRecords(data, config) ?? totalRecords;

    if (totalPages !== undefined) {
      if (page >= totalPages) {
        break;
      }

      const nextPage = getNextPage(data, config);
      page = nextPage && nextPage > page ? nextPage : page + 1;
      continue;
    }

    if (items.length < pageSize) {
      break;
    }

    page += 1;

    if (i === maxPages - 1) {
      truncated = true;
    }
  }

  if (totalPages !== undefined && startPage + pagesFetched - 1 < totalPages) {
    truncated = true;
  }

  if (
    totalRecords !== undefined &&
    allItems.length < totalRecords &&
    pagesFetched >= maxPages
  ) {
    truncated = true;
  }

  const data = {
    ...(baseData ?? {}),
    [config.itemKey]: allItems,
    _pagination: {
      autoPaginated: true,
      itemKey: config.itemKey,
      pagesFetched,
      pageSize,
      startPage,
      returnedRecords: allItems.length,
      totalPages,
      totalRecords,
      truncated,
    },
  };

  return {
    status,
    data,
    pagination: data._pagination,
  };
}
