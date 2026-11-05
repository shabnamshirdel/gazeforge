# GazeForge — study analysis
#
#   Rscript analysis/analyze.R            # analyse real sessions in data/*.json
#   Rscript analysis/analyze.R --simulate # run the whole pipeline on simulated data (no participants needed)
#
# Research questions
#   RQ1  Does gaze-implicit steering reduce effort/time vs explicit selection?   (time, rounds, NASA-TLX, SUS)
#   RQ2  Does it change how broadly people explore?                               (design diversity)
#   RQ3  Does attention actually predict choice?                                  (dwell share -> click / final pick)
#
# Packages: jsonlite, dplyr, tidyr, ggplot2, lme4  (install.packages(c(...)) if missing)

suppressPackageStartupMessages({
  library(jsonlite); library(dplyr); library(tidyr); library(ggplot2); library(lme4)
})

args <- commandArgs(trailingOnly = TRUE)
script_dir <- tryCatch(dirname(normalizePath(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE)))),
                       error = function(e) "analysis")
root <- normalizePath(file.path(script_dir, ".."))
data_dir <- file.path(root, "data")
fig_dir <- file.path(script_dir, "figures"); dir.create(fig_dir, showWarnings = FALSE)
json_files <- list.files(data_dir, pattern = "\\.json$", full.names = TRUE)
SIMULATE <- "--simulate" %in% args || length(json_files) == 0
cond_levels <- c("explicit", "gaze", "hybrid")
cond_labels <- c(explicit = "A: Explicit", gaze = "B: Gaze", hybrid = "C: Hybrid")

# ---------------------------------------------------------------------------
# Design-space distance (mirrors genome.js)
gene_def <- list(shade = 5, hue = 0, material = 5, height = 0, arm = 0, base = 4, glow = 0, pattern = 4)  # 0 = numeric
decode_cat <- function(v, k) pmin(k - 1, floor(v * k))
genome_dist <- function(a, b) {
  s <- 0
  for (g in names(gene_def)) {
    k <- gene_def[[g]]
    s <- s + if (k == 0) (a[[g]] - b[[g]])^2 else as.numeric(decode_cat(a[[g]], k) != decode_cat(b[[g]], k))
  }
  sqrt(s / length(gene_def))
}
diversity_of <- function(genomes) {
  n <- length(genomes); if (n < 2) return(NA_real_)
  d <- c(); for (i in 1:(n - 1)) for (j in (i + 1):n) d <- c(d, genome_dist(genomes[[i]], genomes[[j]]))
  mean(d)
}

# ---------------------------------------------------------------------------
# Load real sessions -> option-level (one row per round × option) and trial-level tables
load_sessions <- function(files) {
  opts <- list(); trials <- list()
  for (f in files) {
    s <- fromJSON(f, simplifyVector = FALSE)
    if (is.null(s$final)) next
    cfg <- s$config; seen <- list()
    for (r in s$rounds) {
      dw <- sapply(r$options, function(o) o$dwellMs)
      for (k in seq_along(r$options)) {
        o <- r$options[[k]]
        if (!isTRUE(o$elite) || r$round == 0) seen[[length(seen) + 1]] <- o$genes
        opts[[length(opts) + 1]] <- data.frame(
          participant = cfg$pid, condition = cfg$condition, round = r$round, slot = k - 1,
          dwell_ms = o$dwellMs, dwell_share = if (sum(dw) > 0) o$dwellMs / sum(dw) else NA,
          entries = o$entries, clicked = as.integer(!is.null(r$clickedSlot) && identical(as.integer(r$clickedSlot), k - 1L)),
          has_click = !is.null(r$clickedSlot), final_pick = as.integer(o$id == s$final$optionId),
          is_last = r$round == s$final$round)
      }
    }
    trials[[length(trials) + 1]] <- data.frame(
      participant = cfg$pid, condition = cfg$condition, n_rounds = length(s$rounds),
      time_s = s$final$tMs / 1000, diversity = diversity_of(seen),
      tlx = if (is.null(s$questionnaires)) NA else s$questionnaires$tlxRaw,
      sus = if (is.null(s$questionnaires)) NA else s$questionnaires$sus,
      calib_err_px = if (is.null(s$calibration$validationErrorPx)) NA else s$calibration$validationErrorPx)
  }
  list(opts = bind_rows(opts), trials = bind_rows(trials))
}

# ---------------------------------------------------------------------------
# Simulated study (same table shapes) — for building/validating the pipeline before data collection
simulate_study <- function(n_pp = 14, seed = 7) {
  set.seed(seed)
  eff <- data.frame(condition = cond_levels, d_time = c(0, -22, -28), d_tlx = c(0, -6, -9), d_sus = c(0, 3, 7),
                    d_div = c(0, 0.04, 0.03), d_rounds = c(0, 1, -1))
  opts <- list(); trials <- list()
  for (p in sprintf("P%02d", 1:n_pp)) {
    u <- rnorm(4, 0, c(15, 8, 8, 0.03))  # participant random intercepts
    for (cn in cond_levels) {
      e <- eff[eff$condition == cn, ]
      nr <- max(3, round(rnorm(1, 7 + e$d_rounds, 1.5)))
      for (r in 0:(nr - 1)) {
        dw <- rgamma(4, shape = 1.2) * 1500
        share <- dw / sum(dw)
        has_click <- cn != "gaze" && (cn == "explicit" || runif(1) < 0.4)
        pclick <- exp(4 * share) / sum(exp(4 * share))   # attention predicts choice
        clicked <- if (has_click) sample(0:3, 1, prob = pclick) else -1
        final <- if (r == nr - 1) sample(0:3, 1, prob = pclick) else -1
        opts[[length(opts) + 1]] <- data.frame(participant = p, condition = cn, round = r, slot = 0:3,
          dwell_ms = dw, dwell_share = share, entries = rpois(4, 1.5) + 1, clicked = as.integer(0:3 == clicked),
          has_click = has_click, final_pick = as.integer(0:3 == final), is_last = r == nr - 1)
      }
      trials[[length(trials) + 1]] <- data.frame(participant = p, condition = cn, n_rounds = nr,
        time_s = max(20, rnorm(1, 95 + e$d_time + u[1], 12)), diversity = rnorm(1, 0.55 + e$d_div + u[4], 0.04),
        tlx = pmin(100, pmax(0, rnorm(1, 45 + e$d_tlx + u[2], 7))), sus = pmin(100, pmax(0, rnorm(1, 70 + e$d_sus + u[3], 7))),
        calib_err_px = round(rnorm(1, 90, 20)))
    }
  }
  list(opts = bind_rows(opts), trials = bind_rows(trials))
}

dat <- if (SIMULATE) simulate_study() else load_sessions(json_files)
tag <- if (SIMULATE) " [SIMULATED DATA]" else ""
cat(sprintf("\nGazeForge analysis%s — %d participants, %d trials, %d option-rows\n\n",
            tag, n_distinct(dat$trials$participant), nrow(dat$trials), nrow(dat$opts)))

trials <- dat$trials %>% mutate(condition = factor(condition, levels = cond_levels))
opts <- dat$opts %>% mutate(condition = factor(condition, levels = cond_levels))

# ---------------------------------------------------------------------------
# Descriptives
desc <- trials %>% group_by(condition) %>%
  summarise(n = n(), across(c(time_s, n_rounds, diversity, tlx, sus), list(m = ~mean(.x, na.rm = TRUE), sd = ~sd(.x, na.rm = TRUE))), .groups = "drop")
print(as.data.frame(desc), digits = 3)

# ---------------------------------------------------------------------------
# RQ1/RQ2 — mixed models, condition as fixed effect, participant random intercept
fit_lmm <- function(dv) {
  d <- trials %>% filter(!is.na(.data[[dv]]))
  if (n_distinct(d$participant) < 3 || n_distinct(d$condition) < 2) { cat(sprintf("\n[%s] not enough data for a mixed model\n", dv)); return(NULL) }
  m <- lmer(as.formula(paste(dv, "~ condition + (1 | participant)")), data = d, REML = FALSE)
  m0 <- update(m, . ~ . - condition)
  lrt <- anova(m0, m)
  cat(sprintf("\n== %s ~ condition + (1|participant)  — LRT χ²(%d) = %.2f, p = %.4f\n", dv, lrt$Df[2], lrt$Chisq[2], lrt$`Pr(>Chisq)`[2]))
  print(round(coef(summary(m)), 3))
  m
}
models <- lapply(c("time_s", "n_rounds", "tlx", "sus", "diversity"), fit_lmm)

# ---------------------------------------------------------------------------
# RQ3 — does attention predict choice?
clicks <- opts %>% filter(has_click, !is.na(dwell_share))
if (nrow(clicks) > 20 && n_distinct(clicks$participant) >= 3) {
  g <- glmer(clicked ~ dwell_share + (1 | participant), data = clicks, family = binomial)
  cat("\n== P(clicked) ~ dwell_share + (1|participant)\n"); print(round(coef(summary(g)), 3))
}
round_agree <- opts %>% filter(has_click) %>% group_by(participant, condition, round) %>%
  summarise(agree = slot[which.max(dwell_ms)] == slot[clicked == 1][1], .groups = "drop")
final_agree <- opts %>% filter(is_last) %>% group_by(participant, condition) %>%
  summarise(agree = slot[which.max(dwell_ms)] == slot[final_pick == 1][1], .groups = "drop")
cat(sprintf("\nMax-dwell option == clicked option: %.1f%% of %d rounds (chance = 25%%)\n",
            100 * mean(round_agree$agree, na.rm = TRUE), nrow(round_agree)))
cat(sprintf("Max-dwell option in last round == final pick: %.1f%% of %d trials\n",
            100 * mean(final_agree$agree, na.rm = TRUE), nrow(final_agree)))

# ---------------------------------------------------------------------------
# Figures
theme_gf <- theme_minimal(base_size = 12) + theme(panel.grid.minor = element_blank(), legend.position = "none",
                                                  plot.title = element_text(face = "bold"))
long <- trials %>% select(participant, condition, `Time to final (s)` = time_s, `NASA-TLX (raw)` = tlx,
                          `SUS` = sus, `Design diversity` = diversity) %>%
  pivot_longer(-c(participant, condition), names_to = "measure", values_to = "value")
p1 <- ggplot(long, aes(condition, value)) +
  geom_line(aes(group = participant), colour = "grey80", linewidth = 0.4) +
  geom_point(colour = "grey60", size = 1.2) +
  stat_summary(fun.data = mean_cl_normal, geom = "pointrange", colour = "#C98A12", linewidth = 0.9, size = 0.6) +
  facet_wrap(~measure, scales = "free_y", nrow = 1) +
  scale_x_discrete(labels = cond_labels) +
  labs(x = NULL, y = NULL, title = paste0("Outcomes by condition", tag),
       subtitle = "Grey lines: individual participants; amber: mean +/- 95% CI") + theme_gf
ggsave(file.path(fig_dir, "outcomes_by_condition.png"), p1, width = 11, height = 3.6, dpi = 200, bg = "white")

if (nrow(clicks) > 0) {
  binned <- clicks %>% mutate(bin = cut(dwell_share, breaks = seq(0, 1, 0.1), include.lowest = TRUE)) %>%
    group_by(bin) %>% summarise(x = mean(dwell_share), p = mean(clicked), n = n(), .groups = "drop")
  p2 <- ggplot(clicks, aes(dwell_share, clicked)) +
    geom_smooth(method = "glm", method.args = list(family = binomial), colour = "#C98A12", fill = "#F2B544", alpha = 0.2, formula = y ~ x) +
    geom_point(data = binned, aes(x, p, size = n), colour = "grey30") +
    geom_hline(yintercept = 0.25, linetype = "dashed", colour = "grey60") +
    annotate("text", x = 0.02, y = 0.28, label = "chance (1 of 4)", hjust = 0, colour = "grey50", size = 3.2) +
    scale_x_continuous(labels = scales::percent) + scale_y_continuous(labels = scales::percent, limits = c(0, 1)) +
    labs(x = "Share of round dwell time on the option", y = "P(option clicked)",
         title = paste0("Attention predicts choice", tag), subtitle = "Rounds with an explicit click (conditions A and C)") +
    theme_gf
  ggsave(file.path(fig_dir, "dwell_predicts_choice.png"), p2, width = 6, height = 4.2, dpi = 200, bg = "white")
}
write.csv(trials, file.path(script_dir, "trial_summary.csv"), row.names = FALSE)
cat(sprintf("\nFigures → %s\nTrial table → %s\n", fig_dir, file.path(script_dir, "trial_summary.csv")))
