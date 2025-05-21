import { describe, test, expect } from "bun:test";
import { extractSegments, extractRoute } from "./FileRouter";

describe("extractSegments", () => {
  test("should return empty array for empty path", () => {
    expect(extractSegments("")).toEqual([]);
  });

  test("should return empty array for root path", () => {
    expect(extractSegments("/")).toEqual([]);
  });

  test("should extract literal segments", () => {
    expect(extractSegments("/users/posts/latest")).toEqual([
      { type: "Literal", text: "users" },
      { type: "Literal", text: "posts" },
      { type: "Literal", text: "latest" },
    ]);
  });

  test("should handle multiple slashes", () => {
    expect(extractSegments("/users///posts//latest/")).toEqual([
      { type: "Literal", text: "users" },
      { type: "Literal", text: "posts" },
      { type: "Literal", text: "latest" },
    ]);
  });

  test("should extract dynamic parameter", () => {
    expect(extractSegments("/users/[userId]")).toEqual([
      { type: "Literal", text: "users" },
      { type: "DynamicParam", text: "userId" },
    ]);
  });

  test("should extract optional parameter", () => {
    expect(extractSegments("/items/[[itemId]]")).toEqual([
      { type: "Literal", text: "items" },
      { type: "OptionalParam", text: "itemId" },
    ]);
  });
  
  test("should extract rest parameter", () => {
    expect(extractSegments("/files/[...filePath]")).toEqual([
      { type: "Literal", text: "files" },
      { type: "RestParam", text: "[...filePath]" },
    ]);
  });

  test("should extract page handle", () => {
    expect(extractSegments("/about/+page.tsx")).toEqual([
      { type: "Literal", text: "about" },
      { type: "PageHandle", extension: "tsx" },
    ]);
  });

  test("should extract server handle", () => {
    expect(extractSegments("/api/users/+server.ts")).toEqual([
      { type: "Literal", text: "api" },
      { type: "Literal", text: "users" },
      { type: "ServerHandle", extension: "ts" },
    ]);
  });

  test("should return null for invalid segment", () => {
    expect(extractSegments("/users/[invalid[id]]")).toBeNull();
    expect(extractSegments("/[[...invalid]]")).toBeNull(); // optional rest is invalid
    expect(extractSegments("/[...]]")).toBeNull(); // empty rest name
    expect(extractSegments("/[[]]")).toBeNull(); // empty optional name
    expect(extractSegments("/api/+server")).toBeNull(); // missing extension
    expect(extractSegments("/api/+page.foo.bar")).toBeNull(); // too many dots in handle
    expect(extractSegments("/api/+page.xyz")).toBeNull(); // invalid extension
    expect(extractSegments("/api/+other.ts")).toBeNull(); // invalid handle type
  });

  test("should handle mixed segments and handles", () => {
    expect(extractSegments("/products/[productId]/reviews/+page.jsx")).toEqual([
      { type: "Literal", text: "products" },
      { type: "DynamicParam", text: "productId" },
      { type: "Literal", text: "reviews" },
      { type: "PageHandle", extension: "jsx" },
    ]);
  });
});

describe("extractRoute", () => {
  test("should return null if no segments", () => {
    expect(extractRoute("")).toBeNull(); // extractSegments returns [], which is not a valid Route
  });

  test("should return null if last segment is not a handle", () => {
    expect(extractRoute("/users/posts")).toBeNull();
  });

  test("should extract route with PageHandle", () => {
    const path = "/dashboard/settings/+page.tsx";
    const segments = extractSegments(path); // Use the already tested extractSegments
    expect(extractRoute(path)).toEqual(segments);
  });

  test("should extract route with ServerHandle", () => {
    const path = "/api/data/+server.ts";
    const segments = extractSegments(path);
    expect(extractRoute(path)).toEqual(segments);
  });
  
  test("should return null for path that extractSegments returns null", () => {
    expect(extractRoute("/api/+invalid")).toBeNull();
  });
});
