"use client";

import * as d3 from "d3";
import React, { useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { fetchLogs } from "../utils/googleSheetsApi"; // Adjust path as needed

export default function ContributionGrid({ goalId }) {
  const svgRef = useRef();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadLogs() {
      try {
        const allLogs = await fetchLogs(); // Fetch raw logs
        // Assume goalId is numeric; adjust conversion if needed.
        const goalLogs = allLogs.filter((log) => log.g_id === parseInt(goalId));

        // Transform logs into daily contributions for the grid.
        // Each log has a start_datetime and duration.
        // Count days with at least one focus session.
        const contributions = {};
        goalLogs.forEach(({ start_datetime, duration }) => {
          // Format using date-fns so the key is in local time.
          const date = format(new Date(start_datetime), "yyyy-MM-dd");
          if (!contributions[date]) contributions[date] = 0;
          if (duration > 0) contributions[date] += 1;
        });

        const transformedLogs = Object.entries(contributions).map(
          ([date, count]) => ({ date, count })
        );
        setLogs(transformedLogs);
      } catch (error) {
        console.error("Error loading logs:", error);
      } finally {
        setLoading(false);
      }
    }
    loadLogs();
  }, [goalId]);

  useEffect(() => {
    // Render the grid even if logs are empty, so the grid always appears
    const cellSize = 30; // New cell size
    const gap = 4;       // Increased gap between cells
    const margin = { top: 20, right: 20, bottom: 20, left: 20 };
    const width = 500;   // Fixed coordinate system width
    const height = 300;  // Fixed coordinate system height

    const today = new Date();
    // Calculate current quarter start and end dates
    const quarterStart = new Date(
      today.getFullYear(),
      Math.floor(today.getMonth() / 3) * 3,
      1
    );
    const quarterEnd = new Date(
      today.getFullYear(),
      Math.floor(today.getMonth() / 3) * 3 + 3,
      0
    );

    // Generate all dates in the current quarter using d3's timeDays
    const allDates = d3.timeDays(quarterStart, d3.timeDay.offset(quarterEnd, 1));
    // Create a Map where keys are date strings ("yyyy-MM-dd") and values are focus session counts
    const dataMap = new Map(logs.map((d) => [d.date, d.count]));

    // Create a color scale using GitHub-like colors for 0–4+ sessions
    const colorScale = d3.scaleThreshold()
      .domain([1, 2, 3, 4])
      .range(["#ebedf0", "#c6e48b", "#7bc96f", "#239a3b", "#196127"]);

    // Select the SVG element and clear previous content
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    // Make the SVG responsive by setting its width to 100% and adding a viewBox and preserveAspectRatio.
    svg
      .attr("width", "100%")
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("preserveAspectRatio", "xMinYMin meet");

    // Create a tooltip
    const tooltip = d3.select("body")
      .append("div")
      .style("position", "absolute")
      .style("background-color", "white")
      .style("border", "1px solid #ccc")
      .style("padding", "5px")
      .style("border-radius", "5px")
      .style("display", "none");

    // Render each day as a square
    svg.selectAll(".day")
      .data(allDates)
      .enter()
      .append("rect")
      .attr("class", "day")
      // Arrange cells in columns (weeks) and rows (days of week)
      .attr("x", (d, i) => Math.floor(i / 7) * (cellSize + gap) + margin.left)
      .attr("y", (d, i) => (i % 7) * (cellSize + gap) + margin.top)
      .attr("width", cellSize)
      .attr("height", cellSize)
      .attr("fill", (d) => {
        if (d > today) return "#f0f0f0"; // Future dates in light gray
        const key = format(d, "yyyy-MM-dd");
        const count = dataMap.get(key) || 0;
        return colorScale(count);
      })
      .on("mouseover", function (event, d) {
        const key = format(d, "yyyy-MM-dd");
        const count = dataMap.get(key) || 0;
        tooltip.style("display", "block")
          .html(`${d.toDateString()}: ${count} session(s)`);
        d3.select(this)
          .style("stroke", "#000")
          .style("stroke-width", "2px");
      })
      .on("mousemove", (event) => {
        tooltip.style("top", `${event.pageY + 10}px`)
          .style("left", `${event.pageX + 10}px`);
      })
      .on("mouseout", function () {
        tooltip.style("display", "none");
        d3.select(this).style("stroke", "none");
      });

    // Clean up the tooltip on unmount
    return () => tooltip.remove();
  }, [logs]);

  if (loading) return <div>Loading...</div>;

  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <svg ref={svgRef}></svg>
    </div>
  );
}
