import { z } from "zod";

const nonEmptyText = z.string().trim().min(1).max(20_000);

export const botUpdateSchema = z.object({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  patch: z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      label: z.string().trim().max(120).optional(),
      description: z.string().trim().max(2_000).optional(),
      instructions: z.string().trim().max(20_000).optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, "At least one field is required"),
});

export const botIdSchema = z.string().uuid();
export const sessionIdSchema = z.string().uuid();
export const nonceSchema = z.string().uuid();

export const sendCommandSchema = z.object({
  sessionId: sessionIdSchema,
  clientNonce: nonceSchema,
  text: nonEmptyText,
});

export const modelConfigurationSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .url()
    .max(2_048)
    .refine((value) => {
      const url = new URL(value);
      if (url.username || url.password) return false;
      if (url.protocol === "https:") return true;
      const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
      return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(hostname);
    }, "Use HTTPS, or HTTP only for a loopback address"),
  modelId: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(8_192).optional(),
});
