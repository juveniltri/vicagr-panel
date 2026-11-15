import { limpiar } from "../scripts/guia/entorno";
import { limpiarProyectosE2e } from "./entorno";

// E2E_CONSERVAR=1 leaves everything up to look at a failure in the browser
// (https://localhost); `npm run test:e2e:limpiar` removes it afterwards.
export default async function limpiarTodo(): Promise<void> {
  if (process.env.E2E_CONSERVAR === "1") {
    console.log("E2E_CONSERVAR=1: el stack sigue en https://localhost.");
    return;
  }
  limpiarProyectosE2e();
  limpiar();
}

// `npm run test:e2e:limpiar`, after a run with E2E_CONSERVAR=1 or one that was
// interrupted.
if (process.argv.includes("--ahora")) {
  limpiarProyectosE2e();
  limpiar();
}
