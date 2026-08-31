import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProductUpdateTemplateEditor } from "../../../src/app/(dashboard)/company/product-update-template-editor";

describe("ProductUpdateTemplateEditor", () => {
  it("submits an empty value while the seeded template is untouched", () => {
    render(<ProductUpdateTemplateEditor defaultValue={null} />);
    expect(screen.getByTestId("product-update-template-input")).toHaveValue("");
  });

  it("submits the stored template when one exists", () => {
    render(<ProductUpdateTemplateEditor defaultValue={"# Stored\n"} />);
    expect(screen.getByTestId("product-update-template-input")).toHaveValue("# Stored\n");
  });
});
