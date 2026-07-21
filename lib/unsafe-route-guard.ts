import { NextResponse } from "next/server";

const ENABLE_UNSAFE_DEV_ROUTES = "AO_ENABLE_UNSAFE_DEV_ROUTES";

export function blockUnsafeDevRouteInProduction(routeName: string): Response | null {
  if (process.env.NODE_ENV !== "production") return null;
  if (process.env[ENABLE_UNSAFE_DEV_ROUTES] === "1") return null;

  return NextResponse.json(
    {
      error: "NOT_FOUND",
      message:
        `${routeName} is a dev/test endpoint and is disabled in production. ` +
        `Set ${ENABLE_UNSAFE_DEV_ROUTES}=1 only for an isolated staging box.`,
    },
    { status: 404 },
  );
}
