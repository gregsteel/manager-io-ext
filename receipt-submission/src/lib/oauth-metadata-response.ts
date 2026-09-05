function corsHeaders(): HeadersInit {
  return {
    "cache-control": "public, max-age=60",
    "access-control-allow-origin": "*",
  };
}

export function jsonMetadata(body: unknown): Response {
  return Response.json(body, { headers: corsHeaders() });
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type",
    },
  });
}
