import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { DomainError, ERROR_STATUS } from "../shared/errors";

export function ok(res: Response, data: unknown, meta: Record<string, unknown> = {}): void {
  res.json({ data, meta });
}

export function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    fail(res, 400, "VALIDATION_ERROR", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return;
  }
  if (err instanceof DomainError) {
    fail(res, ERROR_STATUS[err.code], err.code, err.message);
    return;
  }
  console.error("[unhandled]", err);
  fail(res, 500, "INTERNAL_ERROR", "Internal server error");
}
