import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { comprobarSalud } from "@/lib/health";

export async function GET() {
  const result = await comprobarSalud();
  const status = result.status === "ok" ? 200 : 503;
  // Public for monitors and the container healthcheck, which only need the
  // verdict. The version and which piece is down are for the team.
  if (!(await auth()))
    return NextResponse.json({ status: result.status }, { status });
  return NextResponse.json(
    { ...result, timestamp: new Date().toISOString() },
    { status },
  );
}
