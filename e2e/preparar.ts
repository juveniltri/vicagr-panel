import bcrypt from "bcryptjs";
import {
  comprobarRequisitos,
  esperarPanelSano,
  generarEnv,
  limpiar,
  prepararVolumenes,
  reiniciarPanel,
} from "../scripts/guia/entorno";
import {
  BUZON,
  USUARIO,
  arrancarBuzon,
  compose,
  conectarBd,
  guardarEntorno,
  limpiarProyectosE2e,
} from "./entorno";

// Starts the production stack (the one `npm run guia` uses, with the repos
// folder shared with the host) and the user and notification channel the tests
// rely on. Building the image takes a few minutes the first time.
export default async function preparar(): Promise<void> {
  await comprobarRequisitos();
  try {
    const entorno = generarEnv();
    guardarEntorno(entorno);
    limpiarProyectosE2e();
    compose(["up", "-d", "--build"]);
    await esperarPanelSano();
    prepararVolumenes();
    await reiniciarPanel();
    arrancarBuzon();

    const prisma = conectarBd(entorno);
    try {
      await prisma.user.create({
        data: {
          email: USUARIO.email,
          nombre: USUARIO.nombre,
          passwordHash: await bcrypt.hash(USUARIO.password, 12),
        },
      });
      await prisma.configuracionNotificacion.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          webhookHabilitado: true,
          webhookUrl: `http://${BUZON}:8080/`,
        },
        update: {
          webhookHabilitado: true,
          webhookUrl: `http://${BUZON}:8080/`,
        },
      });
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    limpiarProyectosE2e();
    limpiar();
    throw err;
  }
}
