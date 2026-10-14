import { z } from "zod";

export const LIBRARY_TEXT_MAX_BYTES = 1_048_576;
export const LIBRARY_IMPORT_MAX_BYTES = 4 * LIBRARY_TEXT_MAX_BYTES;
export const LIBRARY_MAX_FILES = 250;
export const LIBRARY_MAX_REFERENCES = 20;

export const libraryKindSchema = z.enum(["document", "skill"]);
const id = z.string().uuid();
const name = z.string().trim().min(1).max(120);
const description = z.string().max(2_000);
export const libraryBodySchema = z.string().max(LIBRARY_TEXT_MAX_BYTES)
  .refine((body) => new TextEncoder().encode(body).byteLength <= LIBRARY_TEXT_MAX_BYTES, "Resource text exceeds 1 MiB");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const visibility = { includeDisabled: z.boolean().optional(), includeDeleted: z.boolean().optional() };
const scope = { sessionId: id };
const mutation = { ...scope, id, expectedVersion: z.number().int().positive() };

export const resourceFileRefSchema = z.object({
  relativePath: z.string().min(1).max(500).refine((path) => !/[\\:]/.test(path)
    && Array.from(path).every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
    && !path.startsWith("/") && !/^[a-z]:/i.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."
      && !/[ .]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), "File path must be relative and portable"),
  size: z.number().int().min(0).max(LIBRARY_TEXT_MAX_BYTES),
  mimeType: z.string().min(1).max(120).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  sha256: digest,
}).strict();
export const resourceFilesSchema = z.array(resourceFileRefSchema).max(LIBRARY_MAX_FILES)
  .refine((files) => new Set(files.map((file) => file.relativePath)).size === files.length, "File paths must be unique")
  .refine((files) => files.reduce((size, file) => size + file.size, 0) <= LIBRARY_IMPORT_MAX_BYTES, "Resource files exceed 4 MiB");
export const resourceReferenceSchema = z.object({ resourceId: id, revisionId: id, digest }).strict();
export const resourceReferencesSchema = z.array(resourceReferenceSchema).max(LIBRARY_MAX_REFERENCES)
  .refine((references) => new Set(references.map((reference) => reference.resourceId)).size === references.length, "Resource ids must be unique");

export const libraryListSchema = z.object({ ...scope, ...visibility, kind: libraryKindSchema.optional(), query: z.string().trim().max(200).optional() }).strict();
export const libraryAvailableSchema = z.object({ ...visibility, kind: libraryKindSchema.optional(), query: z.string().trim().max(200).optional() }).strict();
export const libraryReadSchema = z.object({ ...scope, ...visibility, id, revisionId: id.optional() }).strict();
export const libraryCreateSchema = z.object({ ...scope, kind: libraryKindSchema, name, description: description.optional(), body: libraryBodySchema }).strict();
export const libraryUpdateSchema = z.object({ ...mutation, name: name.optional(), description: description.optional(), body: libraryBodySchema.optional() }).strict()
  .refine((input) => input.name !== undefined || input.description !== undefined || input.body !== undefined, "At least one field is required");
export const libraryMutationSchema = z.object(mutation).strict();
export const librarySetEnabledSchema = z.object({ ...mutation, enabled: z.boolean() }).strict();
export const libraryBindingSchema = z.object({ ...scope, id }).strict();
export const libraryVersionsSchema = z.object({ ...scope, ...visibility, id }).strict();
export const libraryRestoreVersionSchema = z.object({ ...mutation, revisionId: id }).strict();
export const libraryPickImportSchema = z.object({ ...scope, kind: libraryKindSchema, directory: z.boolean().optional() }).strict();
export const libraryImportPathSchema = z.object({ ...scope, kind: libraryKindSchema, workspaceId: id, path: z.string().min(1).max(500) }).strict();
export const libraryExportSchema = z.object({ ...scope, id, revisionId: id.optional() }).strict();
