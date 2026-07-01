# ─────────────────────────────────────────────
# IVR Generator – Docker Image
# ─────────────────────────────────────────────

# Use official LTS Node image on Alpine for a smaller footprint
FROM node:20-alpine

# Install ffmpeg (required by fluent-ffmpeg)
RUN apk add --no-cache ffmpeg

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Set working directory
WORKDIR /app

# Copy dependency manifests first (better layer caching)
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Ensure uploads/results/songs directories exist and are writable
RUN mkdir -p upload results songs && chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose application port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3000/ || exit 1

# Start server
CMD ["node", "server.js"]
