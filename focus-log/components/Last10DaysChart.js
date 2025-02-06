"use client";

import React, { useEffect, useState } from "react";
import { fetchLogs } from "../utils/googleSheetsApi";
import { format, subDays } from "date-fns";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

export default function Last10DaysChart({ goalId }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadLogs() {
      try {
        const allLogs = await fetchLogs();
        const goalLogs = allLogs.filter((log) => log.g_id === parseInt(goalId));

        // Build an array representing the last 10 days (oldest at left, newest at right)
        const today = new Date();
        const last10Days = [];
        // Loop backwards (9 days ago to today)
        for (let i = 9; i >= 0; i--) {
          const day = subDays(today, i);
          const dayString = format(day, "yyyy-MM-dd");
          last10Days.push({ date: dayString, minutes: 0 });
        }

        // Sum durations for each day (assumes log.duration is in minutes)
        goalLogs.forEach((log) => {
          const logDate = format(new Date(log.start_datetime), "yyyy-MM-dd");
          const index = last10Days.findIndex((item) => item.date === logDate);
          if (index !== -1) {
            last10Days[index].minutes += log.duration;
          }
        });

        setData(last10Days);
      } catch (error) {
        console.error("Error loading logs for chart:", error);
      } finally {
        setLoading(false);
      }
    }
    loadLogs();
  }, [goalId]);

  if (loading) return <div>Loading chart...</div>;

  return (
    <div className="chart-container">
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip formatter={(value) => `${value} min`} />
          <Line type="monotone" dataKey="minutes" stroke="#c6e48b" strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
