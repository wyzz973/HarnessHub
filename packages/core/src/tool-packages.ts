// SPDX-License-Identifier: MIT
export interface ToolPackageManagement {
  list(): Promise<unknown>;
  apply(input: unknown): Promise<unknown>;
}
