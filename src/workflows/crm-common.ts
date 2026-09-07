export type CrmRecord = Record<string, unknown>;
export function record(value: unknown): CrmRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as CrmRecord : {};
}
export function records(value: unknown): CrmRecord[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
}
export function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function normalizeText(value: unknown): string {
  return (string(value) ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
export function normalizeEmail(value: unknown): string {
  return (string(value) ?? "").toLowerCase();
}
export function normalizePhone(value: unknown): string {
  // Do not guess a country code or use a suffix match: these can join distinct people.
  return (string(value) ?? "").replace(/^00/, "+").replace(/[^\d]/g, "");
}
export function crmWarnings(data: CrmRecord): string[] {
  return records(data.Warnings).map((warning) => String(warning.ShortText ?? warning.Message ?? warning.Code ?? "CRM warning"));
}
export interface DataCoverage {
  source: string;
  fetchedAt: string;
  fetchedRecords: number;
  totalRecords?: number;
  complete: boolean;
  scope: string;
  warnings: string[];
}
