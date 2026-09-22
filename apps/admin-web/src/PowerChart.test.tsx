import { expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { PowerChart } from "./PowerChart.tsx";

const now = Date.parse("2026-09-22T10:00:00.000Z");
const min = (m: number) => now + m * 60_000;

test("draws one line per readable run, labels the latest value, and says when there is nothing", () => {
  const { container, rerender } = render(<PowerChart points={[]} now={now} windowMs={600_000} />);
  expect(screen.getByText("No readings yet")).toBeInTheDocument();

  rerender(
    <PowerChart
      points={[
        { time: min(-8), power: 1000 },
        { time: min(-6), power: 1200 },
        { time: min(-4), power: null },
        { time: min(-2), power: 1430 },
        { time: min(-1), power: 1500 },
      ]}
      now={now}
      windowMs={600_000}
    />,
  );
  const figure = screen.getByRole("figure", { name: "Active power, last 10 minutes" });
  expect(container.querySelectorAll("path.line")).toHaveLength(2); // the null breaks the line
  expect(within(figure).getByText("1,500 W")).toBeInTheDocument();
  expect(within(figure).getByText("-10 min")).toBeInTheDocument();
  expect(within(figure).getByText("now")).toBeInTheDocument();
  expect(screen.queryByText("No readings yet")).not.toBeInTheDocument();
});
