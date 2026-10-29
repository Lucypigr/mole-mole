import { cacheManifest } from "./generated/cache-manifest.js";
import {
  createNotModifiedResponse,
  ETAG_FALLBACK_HEADER,
  etagMatches,
  getManifestEtag,
} from "./shared/cache.js";

interface MiddlewareContext {
  request: Request;
  next: (options?: { headers?: Record<string, string> }) => Response;
}

export function middleware(context: MiddlewareContext): Response {
  const ifNoneMatch = context.request.headers.get("if-none-match");
  if (!ifNoneMatch) {
    return context.next();
  }

  if (context.request.method === "GET") {
    const etag = getManifestEtag(new URL(context.request.url), cacheManifest);
    if (etag && etagMatches(ifNoneMatch, etag)) {
      const response = createNotModifiedResponse(etag);
      response.headers.set("X-SeerAPI-Cache", "middleware-304");
      return response;
    }
  }

  // 保留现有回退逻辑，因为 EdgeOne 可能会在请求到达云函数之前
  // 移除 If-None-Match 头。
  return context.next({
    headers: {
      [ETAG_FALLBACK_HEADER]: ifNoneMatch,
    },
  });
}

export const config = {
  matcher: ["/v1/:path*"],
};
