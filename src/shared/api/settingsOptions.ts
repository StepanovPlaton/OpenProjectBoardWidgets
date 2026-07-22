import type { ConnectionSettings, PopupFieldOption, PopupSelectOption, PopupSettingsOptions } from "../types";
import { ApiError, OpenProjectClient, isRecord, linkHref } from "./client";

type SchemaLike = Record<string, unknown>;
type WorkPackageLike = Record<string, unknown>;

interface WorkPackageCollection {
  _embedded?: {
    elements?: WorkPackageLike[];
    schemas?: Record<string, SchemaLike>;
  };
}

function clientFromConnection(connection: ConnectionSettings): OpenProjectClient {
  const baseUrl = connection.baseUrl.trim().replace(/\/+$/, "");
  const token = connection.token.trim();
  if (!baseUrl || !token) {
    throw new ApiError("Configure base URL and API token in the extension popup", 0, "CONFIG");
  }
  return OpenProjectClient.fromConnection(baseUrl, token);
}

function parseCustomFieldOption(raw: unknown): PopupSelectOption | null {
  if (typeof raw === "string" || typeof raw === "number") {
    const text = String(raw).trim();
    return text ? { value: text, label: text } : null;
  }

  if (!isRecord(raw)) return null;

  const id =
    typeof raw.id === "number"
      ? String(raw.id)
      : typeof raw.id === "string"
        ? raw.id
        : typeof raw.href === "string"
          ? raw.href.replace(/\/+$/, "").split("/").pop() ?? ""
          : "";

  const labelCandidates = [raw.name, raw.title, raw.value];
  const label = labelCandidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);

  if (!id || !label) return null;
  return { value: id, label };
}

function parseEmbeddedOptions(raw: unknown): PopupSelectOption[] {
  if (!isRecord(raw)) return [];

  const arrays = [
    raw.customOptions,
    raw.allowedValues,
    raw.possibleValues,
    isRecord(raw._embedded) ? raw._embedded.customOptions : null,
    isRecord(raw._embedded) ? raw._embedded.allowedValues : null,
    isRecord(raw._embedded) ? raw._embedded.elements : null,
  ];

  for (const candidate of arrays) {
    if (!Array.isArray(candidate)) continue;
    const parsed = candidate.map(parseCustomFieldOption).filter((value): value is PopupSelectOption => value != null);
    if (parsed.length > 0) return parsed;
  }

  return [];
}

function dedupeOptions(options: PopupSelectOption[]): PopupSelectOption[] {
  const byValue = new Map<string, PopupSelectOption>();
  for (const option of options) {
    if (!option.value) continue;
    byValue.set(option.value, option);
  }
  return [...byValue.values()].sort((a, b) => a.label.localeCompare(b.label, "ru"));
}

function dedupeFieldOptions(options: PopupFieldOption[]): PopupFieldOption[] {
  const byValue = new Map<string, PopupFieldOption>();
  for (const option of options) {
    if (!option.value) continue;
    byValue.set(option.value, option);
  }
  return [...byValue.values()].sort((a, b) => a.label.localeCompare(b.label, "ru"));
}

async function fetchWorkPackageSchemas(client: OpenProjectClient): Promise<SchemaLike[]> {
  const collection = await client.getJson<WorkPackageCollection>("/api/v3/work_packages?pageSize=50");
  const embeddedSchemas = Object.values(collection._embedded?.schemas ?? {}).filter(isRecord);
  const seen = new Set<string>();
  const result: SchemaLike[] = [];

  for (const schema of embeddedSchemas) {
    const href = linkHref(schema, "self");
    if (href) seen.add(href);
    result.push(schema);
  }

  const schemaHrefs = new Set<string>();
  for (const wp of collection._embedded?.elements ?? []) {
    if (!isRecord(wp)) continue;
    const href = linkHref(wp, "schema");
    if (href) schemaHrefs.add(href);
  }

  for (const href of schemaHrefs) {
    if (seen.has(href)) continue;
    try {
      const schema = await client.getJson<SchemaLike>(href);
      result.push(schema);
      seen.add(href);
    } catch {
      // Ignore inaccessible schema variants.
    }
  }

  return result;
}

async function fetchWorkPackageSamples(client: OpenProjectClient): Promise<WorkPackageLike[]> {
  try {
    const collection = await client.getJson<WorkPackageCollection>("/api/v3/work_packages?pageSize=100");
    return (collection._embedded?.elements ?? []).filter(isRecord);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return [];
    }
    throw error;
  }
}

function schemaKeys(schema: SchemaLike): string[] {
  return Object.keys(schema).filter((key) => /^customField\d+$/i.test(key));
}

function fieldType(fieldSchema: SchemaLike): string {
  return typeof fieldSchema.type === "string" ? fieldSchema.type : "";
}

function fieldName(fieldKey: string, fieldSchema: SchemaLike): string {
  if (typeof fieldSchema.name === "string" && fieldSchema.name.trim()) {
    return fieldSchema.name.trim();
  }
  return fieldKey;
}

function fieldHasLinkedValues(fieldSchema: SchemaLike): boolean {
  if (typeof fieldSchema.location === "string" && fieldSchema.location === "_links") return true;
  if (parseEmbeddedOptions(fieldSchema).length > 0) return true;

  const links = fieldSchema._links;
  if (!isRecord(links)) return false;
  return isRecord(links.allowedValues) || Array.isArray(links.allowedValues);
}

function isNumericField(fieldSchema: SchemaLike): boolean {
  const type = fieldType(fieldSchema).toLowerCase();
  return ["integer", "float", "decimal", "number"].includes(type);
}

function isNumericValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim() !== "") {
    return Number.isFinite(Number(value));
  }
  return false;
}

function toFieldOption(fieldKey: string, fieldSchema: SchemaLike): PopupFieldOption {
  const type = fieldType(fieldSchema);
  const label = type ? `${fieldName(fieldKey, fieldSchema)} (${type})` : fieldName(fieldKey, fieldSchema);
  return {
    value: fieldKey,
    label,
    fieldFormat: type,
  };
}

async function loadAllowedValuesFromLinks(
  client: OpenProjectClient,
  links: Record<string, unknown>,
): Promise<PopupSelectOption[]> {
  const allowed = links.allowedValues;
  if (Array.isArray(allowed)) {
    return dedupeOptions(allowed.map(parseCustomFieldOption).filter((value): value is PopupSelectOption => value != null));
  }
  if (!isRecord(allowed) || typeof allowed.href !== "string" || !allowed.href) {
    return [];
  }

  try {
    const collection = await client.getJson<Record<string, unknown>>(allowed.href);
    return dedupeOptions(parseEmbeddedOptions(collection));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return [];
    }
    throw error;
  }
}

async function valuesForDepartmentField(
  client: OpenProjectClient,
  schemas: SchemaLike[],
  departmentField: string,
): Promise<PopupSelectOption[]> {
  const collected: PopupSelectOption[] = [];

  for (const schema of schemas) {
    const rawField = schema[departmentField];
    if (!isRecord(rawField)) continue;

    const embedded = parseEmbeddedOptions(rawField);
    if (embedded.length > 0) {
      collected.push(...embedded);
    }

    const links = rawField._links;
    if (isRecord(links)) {
      try {
        collected.push(...(await loadAllowedValuesFromLinks(client, links)));
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    }
  }

  return dedupeOptions(collected);
}

function fieldOptionFromSample(fieldKey: string, samples: WorkPackageLike[]): PopupFieldOption {
  const titles = new Set<string>();
  for (const wp of samples) {
    const links = isRecord(wp._links) ? wp._links : null;
    const linkValue = links && isRecord(links[fieldKey]) && typeof links[fieldKey].title === "string" ? links[fieldKey].title : "";
    if (linkValue) titles.add(linkValue);
  }

  const sampleLabel = titles.size > 0 ? [...titles][0] : fieldKey;
  return {
    value: fieldKey,
    label: `${sampleLabel} (${fieldKey})`,
  };
}

function collectDepartmentFieldsFromSamples(samples: WorkPackageLike[]): PopupFieldOption[] {
  const fieldKeys = new Set<string>();

  for (const wp of samples) {
    for (const key of Object.keys(wp)) {
      if (!/^customField\d+$/i.test(key)) continue;
      const raw = wp[key];
      if (typeof raw === "string" && raw.trim()) fieldKeys.add(key);
      if (typeof raw === "number" && Number.isFinite(raw)) fieldKeys.add(key);
    }

    const links = isRecord(wp._links) ? wp._links : null;
    if (!links) continue;
    for (const key of Object.keys(links)) {
      if (!/^customField\d+$/i.test(key)) continue;
      const link = links[key];
      if (isRecord(link) && typeof link.title === "string" && link.title.trim()) {
        fieldKeys.add(key);
      }
    }
  }

  return [...fieldKeys].map((key) => fieldOptionFromSample(key, samples));
}

function collectDepartmentValuesFromSamples(samples: WorkPackageLike[], departmentField: string): PopupSelectOption[] {
  const options: PopupSelectOption[] = [];

  for (const wp of samples) {
    const links = isRecord(wp._links) ? wp._links : null;
    if (links && isRecord(links[departmentField])) {
      const link = links[departmentField];
      const href =
        typeof link.href === "string" ? link.href.replace(/\/+$/, "").split("/").pop() ?? "" : "";
      const title = typeof link.title === "string" ? link.title.trim() : "";
      if (href && title) {
        options.push({ value: href, label: title });
        continue;
      }
    }

    const raw = wp[departmentField];
    if (typeof raw === "string" && raw.trim()) {
      options.push({ value: raw.trim(), label: raw.trim() });
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      const value = String(raw);
      options.push({ value, label: value });
    }
  }

  return dedupeOptions(options);
}

function collectStoryPointFieldsFromSamples(samples: WorkPackageLike[]): PopupFieldOption[] {
  const keys = new Set<string>();
  for (const wp of samples) {
    for (const key of Object.keys(wp)) {
      if (!/^customField\d+$/i.test(key)) continue;
      if (isNumericValue(wp[key])) keys.add(key);
    }
  }

  return [...keys].map((key) => ({
    value: key,
    label: key,
  }));
}

export async function fetchPopupSettingsOptions(
  connection: ConnectionSettings,
  departmentField: string,
): Promise<PopupSettingsOptions> {
  const client = clientFromConnection(connection);
  const schemas = await fetchWorkPackageSchemas(client);
  const samples = await fetchWorkPackageSamples(client);

  const departmentFieldOptions: PopupFieldOption[] = [];
  const storyPointFieldOptions: PopupFieldOption[] = [{ value: "storyPoints", label: "Story Points (системное поле)" }];

  for (const schema of schemas) {
    for (const key of schemaKeys(schema)) {
      const rawField = schema[key];
      if (!isRecord(rawField)) continue;

      if (fieldHasLinkedValues(rawField)) {
        departmentFieldOptions.push(toFieldOption(key, rawField));
      }

      if (isNumericField(rawField)) {
        storyPointFieldOptions.push(toFieldOption(key, rawField));
      }
    }
  }

  if (departmentFieldOptions.length === 0) {
    departmentFieldOptions.push(...collectDepartmentFieldsFromSamples(samples));
  }

  if (storyPointFieldOptions.length === 1) {
    storyPointFieldOptions.push(...collectStoryPointFieldsFromSamples(samples));
  }

  const departmentFields = dedupeFieldOptions(departmentFieldOptions);
  const storyPointFields = dedupeFieldOptions(storyPointFieldOptions);

  let departmentValues = departmentField ? await valuesForDepartmentField(client, schemas, departmentField) : [];
  if (departmentValues.length === 0 && departmentField) {
    departmentValues = collectDepartmentValuesFromSamples(samples, departmentField);
  }

  return {
    departmentFields,
    departmentValues,
    storyPointFields,
  };
}
