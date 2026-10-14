import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authorizedModelImages, imageAwareChatMessages, modelImageDataUrl, toolImageResponse, type ModelImageAttachment } from "./model-image";

const pixels = readFileSync(join(process.cwd(), "resources/icon.png"));
function attachment(isAuthorized = () => true): ModelImageAttachment {
  return { reference: { id: randomUUID(), name: "repository-icon.png", size: pixels.length, mimeType: "image/png", sha256: createHash("sha256").update(pixels).digest("hex") },
    dataBase64: pixels.toString("base64"), isAuthorized };
}

describe("model image authority and real pixel validation", () => {
  it("preserves the actual repository PNG bytes and content digest", () => {
    const image = attachment();
    expect(authorizedModelImages([image])).toEqual([image]);
    const transported = Buffer.from(modelImageDataUrl(image).split(",")[1]!, "base64");
    expect(transported.equals(pixels)).toBe(true);
    expect(createHash("sha256").update(transported).digest("hex")).toBe(image.reference.sha256);
  });

  it.each(["sha", "size", "zero", "oversized", "mime", "signature", "base64"])("rejects invalid %s before model transmission", field => {
    const image = attachment();
    if (field === "sha") image.reference.sha256 = "0".repeat(64);
    if (field === "size") image.reference.size--;
    if (field === "zero") image.reference.size = 0;
    if (field === "oversized") image.reference.size = 2_097_153;
    if (field === "mime") image.reference.mimeType = "application/octet-stream";
    if (field === "signature") {
      const wrong = Buffer.from("Plain text is not PNG pixels.");
      image.dataBase64 = wrong.toString("base64"); image.reference.size = wrong.length;
      image.reference.sha256 = createHash("sha256").update(wrong).digest("hex");
    }
    if (field === "base64") image.dataBase64 += "%";
    expect(() => authorizedModelImages([image])).toThrowError(expect.objectContaining({ code: "BROWSER_MEDIA_INVALID" }));
  });

  it("drops a captured image when the user takes control before the responder sends it", () => {
    let owner: "ai" | "user" = "ai", epoch = 1;
    const capturedEpoch = epoch, image = attachment(() => owner === "ai" && epoch === capturedEpoch);
    expect(authorizedModelImages([image])).toHaveLength(1);
    owner = "user"; epoch++;
    const reply = toolImageResponse('{"ok":true,"captured":true}', [image]);
    expect(reply.images).toEqual([]);
    expect(reply.text).toContain("授权已失效");
    const wire = imageAwareChatMessages([{ role: "tool", tool_call_id: "captured", content: "Captured before takeover", images: [image] }]);
    expect(wire).toHaveLength(1);
    expect(JSON.stringify(wire)).not.toContain(image.dataBase64);
    expect(JSON.stringify(wire)).toContain("图片已撤销");
  });

  it("treats a failed authority check as revocation and does not upload unrelated attachments", () => {
    const denied = attachment(() => { throw new Error("Scope removed"); }), valid = attachment();
    const reply = toolImageResponse("Actual receipt", [denied, valid]);
    expect(reply.images).toEqual([valid]);
    expect(reply.text).toContain("授权已失效");
  });
});
