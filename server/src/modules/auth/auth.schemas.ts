import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  // Max only keeps a huge body from being normalized and hashed.
  password: z.string().min(1).max(1024),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Length limits here only keep a huge body from being hashed: the password
 * policy (min 15, max 128, with its own codes) runs in the service. Never
 * trimmed: spaces are valid password characters.
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Escribe tu contraseña actual").max(1024, "Contraseña demasiado larga"),
    newPassword: z.string().min(1, "Escribe la contraseña nueva").max(1024, "Contraseña demasiado larga"),
  })
  .strict();

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
