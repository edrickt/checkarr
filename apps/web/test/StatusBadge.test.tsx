import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import StatusBadge from "../src/components/StatusBadge";
import { STATUS_META } from "../src/status";

describe("StatusBadge", () => {
  it("renders the canonical label with the canonical dot color", () => {
    render(<StatusBadge status="corrupt" />);
    const el = screen.getByText("Corrupt");
    expect(el).toBeInTheDocument();
    expect(el.querySelector("span")?.className).toContain(STATUS_META.corrupt.dot);
  });

  it("explains the status in a tooltip", () => {
    render(<StatusBadge status="suspect" />);
    expect(screen.getByTitle(STATUS_META.suspect.description)).toBeInTheDocument();
  });

  it("falls back to unchecked for unknown statuses", () => {
    render(<StatusBadge status="bogus" />);
    expect(screen.getByText("Unchecked")).toBeInTheDocument();
  });
});
