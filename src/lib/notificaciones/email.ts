import nodemailer from "nodemailer";
import type { PayloadNotificacion } from "./index";
import { asuntoNotificacion } from "./webhook";

export async function enviarEmail(
  config: {
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPass: string;
    remitente: string;
    destinatario: string;
  },
  payload: PayloadNotificacion,
): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    // 465 is implicit TLS; other ports (587, 25) upgrade with STARTTLS
    secure: config.smtpPort === 465,
    connectionTimeout: 10_000,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });

  const lineas = payload.output.split("\n");
  const outputTruncado = lineas.slice(-50).join("\n");

  await transporter.sendMail({
    from: config.remitente,
    to: config.destinatario,
    subject: `[vicagr] ${asuntoNotificacion(payload)} — ${payload.proyectoNombre}`,
    text: [
      `Proyecto: ${payload.proyectoNombre}`,
      `Cliente: ${payload.clienteSlug}`,
      // A fall has no branch or commit to show.
      ...(payload.evento === "servicio"
        ? [""]
        : [
            `Rama: ${payload.rama}`,
            `SHA: ${payload.sha ?? "—"}`,
            `Resultado: ${payload.resultado}`,
            "",
            "Output (últimas 50 líneas):",
          ]),
      outputTruncado,
    ].join("\n"),
  });
}
