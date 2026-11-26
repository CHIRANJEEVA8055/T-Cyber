import { notFound } from "next/navigation";
import { AppError } from "./errors";

/**
 * For pages: a record this officer may not open is shown as "not found", exactly like one that does not exist,
 * and is not logged as a server error (it is an expected, enforced boundary).
 */
export async function orNotFound<T>(load: Promise<T>): Promise<T> {
  try {
    return await load;
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
}
