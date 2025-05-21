import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { Cause } from "effect";
import { HttpRouter } from "@effect/platform/HttpRouter";
import { HttpServerRequest } from "@effect/platform/HttpServerRequest";
import { HttpServerResponse } from "@effect/platform/HttpServerResponse";
import { FileSystem, PlatformError } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { TestHttpServerRequest } from "@effect/platform/testing/HttpServerRequest";
import { fromFiles, InvalidModuleError, ImportError } from "./FileRouter";
import * as NPath from "node:path";
import * as NFSp from "node:fs/promises";

const testRoutesDir = NPath.resolve(__dirname, "temp-test-routes");
const liveFsLayer = NodeFileSystem.layer; // Used by the helper

const makeAbsolute = (relativePath: string) => NPath.join(testRoutesDir, relativePath);

// writeFile remains an async helper, called outside the Effect generators
const writeFile = async (relativePath: string, content: string) => {
  const dir = NPath.dirname(makeAbsolute(relativePath));
  await NFSp.mkdir(dir, { recursive: true });
  await NFSp.writeFile(makeAbsolute(relativePath), content);
};

// Helper function to run tests with a provided layer
function layeredEffectTest<E, A>(
  name: string,
  testGenerator: () => Effect.Effect.Generator<void, E, FileSystem>,
  isFailureTest: boolean = false,
  checkFailure?: (cause: Cause<E>) => void | Promise<void>
) {
  test(name, async () => {
    const effect = Effect.gen(testGenerator);
    const exit = await Effect.runPromiseExit(Effect.provide(effect, liveFsLayer));

    if (isFailureTest) {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && checkFailure) {
        await checkFailure(exit.cause);
      } else if (Exit.isFailure(exit) && !checkFailure) {
        // If it's a failure test and no specific check, it's enough that it failed.
      } else if (Exit.isSuccess(exit)) { 
        // This case means isFailureTest was true, but the effect succeeded.
        throw new Error(`Test "${name}" was expected to fail, but it succeeded.`);
      }
    } else {
      if (Exit.isSuccess(exit)) {
        // Test success is implicit if no errors/expectations fail within the generator.
      } else if (Exit.isFailure(exit)) {
        // Test was expected to succeed but failed. Rethrow to make Bun fail the test clearly.
        console.error(`Test "${name}" failed unexpectedly:`, Cause.pretty(exit.cause));
        throw new Error(`Test "${name}" failed unexpectedly. Cause: ${Cause.pretty(exit.cause)}`);
      }
    }
  });
}

// runApp can be used inside the generator as it returns an Effect
const runApp = (
  router: HttpRouter.HttpRouter,
  req: HttpServerRequest.HttpServerRequest,
) => Effect.provideService(router, HttpServerRequest.HttpServerRequest, req);


describe("fromFiles", () => {
  beforeAll(async () => {
    await NFSp.mkdir(testRoutesDir, { recursive: true });
  });

  afterAll(async () => {
    await NFSp.rm(testRoutesDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    const entries = await NFSp.readdir(testRoutesDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = NPath.join(testRoutesDir, entry.name);
      if (entry.isDirectory()) {
        await NFSp.rm(fullPath, { recursive: true, force: true });
      } else {
        await NFSp.unlink(fullPath);
      }
    }
  });

  layeredEffectTest("Basic +page.tsx", function*() {
    yield* Effect.promise(() => writeFile("+page.tsx", `export default "Hello Root";`));
    const router = yield* fromFiles(testRoutesDir);
    const req = TestHttpServerRequest.get("/");
    const response = yield* runApp(router, req);
    
    expect(response.status).toBe(200);
    const body = yield* HttpServerResponse.textBody(response);
    expect(body).toBe("Hello Root");
  });

  layeredEffectTest("Basic +server.ts", function*() {
    yield* Effect.promise(() => writeFile("api/health/+server.ts", `
      import * as Effect from "effect/Effect";
      import { HttpServerResponse } from "@effect/platform/HttpServerResponse";
      export default Effect.succeed(HttpServerResponse.json({ status: "ok" }));
    `));
    const router = yield* fromFiles(testRoutesDir);
    const req = TestHttpServerRequest.get("/api/health");
    const response = yield* runApp(router, req);

    expect(response.status).toBe(200);
    const body = yield* HttpServerResponse.jsonBody(response);
    expect(body).toEqual({ status: "ok" });
  });

  layeredEffectTest("Nested +page.tsx", function*() {
    yield* Effect.promise(() => writeFile("about/us/+page.tsx", `export default () => "About Us";`));
    const router = yield* fromFiles(testRoutesDir);
    const req = TestHttpServerRequest.get("/about/us");
    const response = yield* runApp(router, req);

    expect(response.status).toBe(200);
    const body = yield* HttpServerResponse.textBody(response);
    expect(body).toBe("About Us");
  });

  layeredEffectTest("Dynamic Parameter +page.tsx", function*() {
    yield* Effect.promise(() => writeFile("users/[userId]/+page.tsx", `export default "User page";`));
    const router = yield* fromFiles(testRoutesDir);
    const req = TestHttpServerRequest.get("/users/123");
    const response = yield* runApp(router, req);

    expect(response.status).toBe(200);
    const body = yield* HttpServerResponse.textBody(response);
    expect(body).toBe("User page");
  });

  layeredEffectTest("Optional Parameter +page.tsx", function*() {
    yield* Effect.promise(() => writeFile("items/[[itemId]]/+page.tsx", `export default "Item page";`));
    const router = yield* fromFiles(testRoutesDir);

    // With parameter
    const req1 = TestHttpServerRequest.get("/items/abc");
    const res1 = yield* runApp(router, req1);
    expect(res1.status).toBe(200);
    const body1 = yield* HttpServerResponse.textBody(res1);
    expect(body1).toBe("Item page");

    // Without parameter
    const req2 = TestHttpServerRequest.get("/items");
    const res2 = yield* runApp(router, req2);
    expect(res2.status).toBe(200);
    const body2 = yield* HttpServerResponse.textBody(res2);
    expect(body2).toBe("Item page");
  });

  layeredEffectTest("Rest Parameter +server.ts", function*() {
    yield* Effect.promise(() => writeFile("files/[...filePath]/+server.ts", `
      import * as Effect from "effect/Effect";
      import { HttpServerResponse } from "@effect/platform/HttpServerResponse";
      export default Effect.succeed(HttpServerResponse.text("File path"));
    `));
    const router = yield* fromFiles(testRoutesDir);
    const req = TestHttpServerRequest.get("/files/foo/bar/baz.txt");
    const response = yield* runApp(router, req);

    expect(response.status).toBe(200);
    const body = yield* HttpServerResponse.textBody(response);
    expect(body).toBe("File path");
  });

  layeredEffectTest("Route Not Found", function*() {
    yield* Effect.promise(() => writeFile("+page.tsx", `export default "Hello";`));
    const router = yield* fromFiles(testRoutesDir);
    const req = TestHttpServerRequest.get("/nonexistent");
    // This specific test expects runApp to fail with RouteNotFound
    // The layeredEffectTest helper will catch this if we mark it as a failure test.
    yield* runApp(router, req); 
  }, true, (cause) => {
    const error = Cause.failureOrCause(cause).left;
    expect(error).toBeInstanceOf(HttpRouter.RouteNotFound);
  });

  layeredEffectTest("Invalid Module: Missing Default Export (+page.tsx)", function*() {
    yield* Effect.promise(() => writeFile("bad/+page.tsx", `export const foo = "bar";`));
    // The error occurs in fromFiles
    yield* fromFiles(testRoutesDir);
  }, true, (cause) => {
    const error = Cause.failureOrCause(cause).left;
    expect(error).toBeInstanceOf(InvalidModuleError);
    if (error instanceof InvalidModuleError) {
      expect(error.message).toContain("Missing default export");
      expect(error.message).toContain(NPath.join(testRoutesDir, "bad", "+page.tsx"));
    }
  });

  layeredEffectTest("Invalid Module: Incorrect Export Type (+server.ts)", function*() {
    yield* Effect.promise(() => writeFile("bad/+server.ts", `export default "not an effect";`));
    yield* fromFiles(testRoutesDir);
  }, true, (cause) => {
    const error = Cause.failureOrCause(cause).left;
    expect(error).toBeInstanceOf(InvalidModuleError);
    if (error instanceof InvalidModuleError) {
      expect(error.message).toContain("No valid route handlers"); // Message changed in later versions
      expect(error.message).toContain(NPath.join(testRoutesDir, "bad", "+server.ts"));
    }
  });

  layeredEffectTest("Invalid Module: +page.tsx function doesn't return string", function*() {
    yield* Effect.promise(() => writeFile("badtype/+page.tsx", `export default () => ({ foo: "bar" });`));
    yield* fromFiles(testRoutesDir);
  }, true, (cause) => {
    const error = Cause.failureOrCause(cause).left;
    expect(error).toBeInstanceOf(InvalidModuleError);
    if (error instanceof InvalidModuleError) {
      expect(error.message).toContain("did not return a string");
      expect(error.message).toContain(NPath.join(testRoutesDir, "badtype", "+page.tsx"));
    }
  });
  
  layeredEffectTest("Invalid Module: +page.tsx export is not string or function", function*() {
    yield* Effect.promise(() => writeFile("badtype2/+page.tsx", `export default { foo: "bar" };`));
    yield* fromFiles(testRoutesDir);
  }, true, (cause) => {
    const error = Cause.failureOrCause(cause).left;
    expect(error).toBeInstanceOf(InvalidModuleError);
    if (error instanceof InvalidModuleError) {
        expect(error.message).toContain("not a string or a function returning a string");
        expect(error.message).toContain(NPath.join(testRoutesDir, "badtype2", "+page.tsx"));
    }
  });

  layeredEffectTest("Empty Directory", function*() {
    // testRoutesDir is already empty due to afterEach
    const router = yield* fromFiles(testRoutesDir);
    const req = TestHttpServerRequest.get("/");
    yield* runApp(router, req); // This should fail
  }, true, (cause) => {
    const error = Cause.failureOrCause(cause).left;
    expect(error).toBeInstanceOf(HttpRouter.RouteNotFound);
  });
  
  layeredEffectTest("Directory Not Found", function*() {
    const nonExistentDir = NPath.join(testRoutesDir, "nonexistent-dir");
    // Error from fromFiles
    yield* fromFiles(nonExistentDir);
  }, true, (cause) => {
    const error = Cause.failureOrCause(cause).left;
    expect(error).toBeInstanceOf(PlatformError);
    if (error instanceof PlatformError) {
      expect(error.reason).toBe("NotFound");
    }
  });
  
  layeredEffectTest("ImportError: File cannot be imported (e.g. syntax error)", function*() {
    yield* Effect.promise(() => writeFile("broken/+server.ts", `export default this is not valid javascript;`));
    yield* fromFiles(testRoutesDir);
  }, true, (cause) => {
    const error = Cause.failureOrCause(cause).left;
    expect(error).toBeInstanceOf(ImportError);
    if (error instanceof ImportError) {
      expect(error.filePath).toBe(NPath.join(testRoutesDir, "broken", "+server.ts"));
      expect(error.error).toBeDefined();
    }
  });

  describe("ServerHandle HTTP Method Specificity", () => {
    layeredEffectTest("Specific GET, POST methods exported, default ignored for specific methods", function*() {
      yield* Effect.promise(() => writeFile("api/methods/+server.ts", `
        import * as Effect from "effect/Effect";
        import { HttpServerResponse } from "@effect/platform/HttpServerResponse";
        export const GET = Effect.succeed(HttpServerResponse.text("GET request"));
        export const POST = Effect.succeed(HttpServerResponse.text("POST request"));
        export default Effect.succeed(HttpServerResponse.text("Default fallback - should not be called for GET/POST"));
      `));
      const router = yield* fromFiles(testRoutesDir);

      // Test GET
      const reqGet = TestHttpServerRequest.get("/api/methods");
      const resGet = yield* runApp(router, reqGet);
      expect(resGet.status).toBe(200);
      expect(yield* HttpServerResponse.textBody(resGet)).toBe("GET request");

      // Test POST
      const reqPost = TestHttpServerRequest.post("/api/methods");
      const resPost = yield* runApp(router, reqPost);
      expect(resPost.status).toBe(200);
      expect(yield* HttpServerResponse.textBody(resPost)).toBe("POST request");

      // Test PUT (should fail with RouteNotFound)
      const reqPut = TestHttpServerRequest.put("/api/methods");
      yield* runApp(router, reqPut); // This line is expected to "throw" within Effect
    }, true, (cause) => { // This outer check is for the PUT request
      const error = Cause.failureOrCause(cause).left;
      expect(error).toBeInstanceOf(HttpRouter.RouteNotFound);
    });
    
    // Separate test for the PUT part to make it cleaner
    layeredEffectTest("Specific GET, POST methods - PUT should fail", function*() {
      yield* Effect.promise(() => writeFile("api/methods/+server.ts", `
        import * as Effect from "effect/Effect";
        import { HttpServerResponse } from "@effect/platform/HttpServerResponse";
        export const GET = Effect.succeed(HttpServerResponse.text("GET request"));
        export const POST = Effect.succeed(HttpServerResponse.text("POST request"));
        export default Effect.succeed(HttpServerResponse.text("Default fallback - should not be called for GET/POST"));
      `));
      const router = yield* fromFiles(testRoutesDir);
      const reqPut = TestHttpServerRequest.put("/api/methods");
      yield* runApp(router, reqPut);
    }, true, (cause) => {
      const error = Cause.failureOrCause(cause).left;
      expect(error).toBeInstanceOf(HttpRouter.RouteNotFound);
    });


    layeredEffectTest("Only Default Export (Fallback to HttpRouter.all)", function*() {
      yield* Effect.promise(() => writeFile("api/defaultonly/+server.ts", `
        import * as Effect from "effect/Effect";
        import { HttpServerResponse } from "@effect/platform/HttpServerResponse";
        export default Effect.succeed(HttpServerResponse.text("Default handler for all methods"));
      `));
      const router = yield* fromFiles(testRoutesDir);

      const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"];
      for (const method of methods) {
        const req = TestHttpServerRequest[method.toLowerCase() as keyof typeof TestHttpServerRequest]("/api/defaultonly");
        const response = yield* runApp(router, req as HttpServerRequest.HttpServerRequest);
        expect(response.status).toBe(200);
        expect(yield* HttpServerResponse.textBody(response)).toBe("Default handler for all methods");
      }
    });

    layeredEffectTest("No Valid Handlers in +server.ts", function*() {
      yield* Effect.promise(() => writeFile("api/nohandlers/+server.ts", `export const value = 123;`));
      yield* fromFiles(testRoutesDir);
    }, true, (cause) => {
      const error = Cause.failureOrCause(cause).left;
      expect(error).toBeInstanceOf(InvalidModuleError);
      if (error instanceof InvalidModuleError) {
        expect(error.message).toContain("No valid route handlers");
        expect(error.message).toContain(NPath.join(testRoutesDir, "api/nohandlers/+server.ts"));
      }
    });

    // Test for "Invalid Method Export Type" needs to be split for clarity
    // Part 1: POST should work
    layeredEffectTest("Invalid Method Export Type - POST works", function*() {
      yield* Effect.promise(() => writeFile("api/badmethod/+server.ts", `
        import * as Effect from "effect/Effect";
        import { HttpServerResponse } from "@effect/platform/HttpServerResponse";
        export const GET = "not an effect"; // Invalid type
        export const POST = Effect.succeed(HttpServerResponse.text("POST request")); // Valid
        export default Effect.succeed(HttpServerResponse.text("Default fallback"));
      `));
      const router = yield* fromFiles(testRoutesDir);
      const reqPost = TestHttpServerRequest.post("/api/badmethod");
      const resPost = yield* runApp(router, reqPost);
      expect(resPost.status).toBe(200);
      expect(yield* HttpServerResponse.textBody(resPost)).toBe("POST request");
    });

    // Part 2: GET should fail (RouteNotFound)
    layeredEffectTest("Invalid Method Export Type - GET fails", function*() {
      yield* Effect.promise(() => writeFile("api/badmethod/+server.ts", `
        import * as Effect from "effect/Effect";
        import { HttpServerResponse } from "@effect/platform/HttpServerResponse";
        export const GET = "not an effect"; // Invalid type
        export const POST = Effect.succeed(HttpServerResponse.text("POST request")); // Valid
        export default Effect.succeed(HttpServerResponse.text("Default fallback"));
      `));
      const router = yield* fromFiles(testRoutesDir);
      const reqGet = TestHttpServerRequest.get("/api/badmethod");
      yield* runApp(router, reqGet);
    }, true, (cause) => {
      const error = Cause.failureOrCause(cause).left;
      expect(error).toBeInstanceOf(HttpRouter.RouteNotFound);
    });
    
    // Part 3: PUT should fail (RouteNotFound because default is ignored)
    layeredEffectTest("Invalid Method Export Type - PUT fails", function*() {
      yield* Effect.promise(() => writeFile("api/badmethod/+server.ts", `
        import * as Effect from "effect/Effect";
        import { HttpServerResponse } from "@effect/platform/HttpServerResponse";
        export const GET = "not an effect"; // Invalid type
        export const POST = Effect.succeed(HttpServerResponse.text("POST request")); // Valid
        export default Effect.succeed(HttpServerResponse.text("Default fallback"));
      `));
      const router = yield* fromFiles(testRoutesDir);
      const reqPut = TestHttpServerRequest.put("/api/badmethod");
      yield* runApp(router, reqPut);
    }, true, (cause) => {
      const error = Cause.failureOrCause(cause).left;
      expect(error).toBeInstanceOf(HttpRouter.RouteNotFound);
    });
    
    layeredEffectTest("Invalid Method Export Type and no other handlers (should fail)", function*() {
      yield* Effect.promise(() => writeFile("api/badmethodonly/+server.ts", `
        export const GET = "not an effect"; // Invalid type
      `));
      yield* fromFiles(testRoutesDir);
    }, true, (cause) => {
      const error = Cause.failureOrCause(cause).left;
      expect(error).toBeInstanceOf(InvalidModuleError);
      if (error instanceof InvalidModuleError) {
        expect(error.message).toContain("No valid route handlers");
        expect(error.message).toContain(NPath.join(testRoutesDir, "api/badmethodonly/+server.ts"));
      }
    });
  });
});
