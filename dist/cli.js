#!/usr/bin/env node
/**
 * TaskFlow CLI - A comprehensive task management tool
 * Demonstrates ~1000 lines of structured, pattern-based code generation
 */
import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import os from 'os';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ============================================================================
// Utility Functions
// ============================================================================
function generateId() {
    return createHash('sha256')
        .update(`${Date.now()}-${Math.random()}-${process.pid}`)
        .digest('hex')
        .slice(0, 12);
}
function parseDate(input) {
    const formats = [
        /^\d{4}-\d{2}-\d{2}$/,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        /^\d{2}\/\d{2}\/\d{4}$/,
        /^\d{2}-\d{2}-\d{4}$/,
    ];
    for (const format of formats) {
        if (format.test(input)) {
            const date = new Date(input);
            if (!isNaN(date.getTime()))
                return date;
        }
    }
    // Relative dates
    const now = new Date();
    if (input === 'today')
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (input === 'tomorrow') {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        return d;
    }
    if (input === 'next-week') {
        const d = new Date(now);
        d.setDate(d.getDate() + 7);
        return d;
    }
    return null;
}
function formatDate(date, format = 'YYYY-MM-DD') {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return format
        .replace('YYYY', String(year))
        .replace('MM', month)
        .replace('DD', day)
        .replace('HH', hours)
        .replace('mm', minutes)
        .replace('ss', seconds);
}
function formatDuration(minutes) {
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours < 24)
        return `${hours}h ${mins}m`;
    const days = Math.floor(hours / 24);
    const hrs = hours % 24;
    return `${days}d ${hrs}h ${mins}m`;
}
function priorityWeight(priority) {
    const weights = { low: 1, medium: 2, high: 3, critical: 4 };
    return weights[priority] || 0;
}
function statusWeight(status) {
    const weights = {
        pending: 1,
        in_progress: 2,
        blocked: 3,
        completed: 4,
        archived: 5
    };
    return weights[status] || 0;
}
// ============================================================================
// Storage Layer
// ============================================================================
class Storage extends EventEmitter {
    dataDir;
    tasksFile;
    projectsFile;
    configFile;
    cache = new Map();
    projectCache = new Map();
    configCache = null;
    dirty = false;
    saveTimer = null;
    constructor(dataDir) {
        super();
        this.dataDir = dataDir;
        this.tasksFile = join(dataDir, 'tasks.json');
        this.projectsFile = join(dataDir, 'projects.json');
        this.configFile = join(dataDir, 'config.json');
        this.ensureDataDir();
        this.load();
    }
    ensureDataDir() {
        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true });
        }
    }
    load() {
        try {
            if (existsSync(this.tasksFile)) {
                const data = JSON.parse(readFileSync(this.tasksFile, 'utf-8'));
                for (const task of data) {
                    this.cache.set(task.id, this.reviveTask(task));
                }
            }
            if (existsSync(this.projectsFile)) {
                const data = JSON.parse(readFileSync(this.projectsFile, 'utf-8'));
                for (const project of data) {
                    this.projectCache.set(project.id, this.reviveProject(project));
                }
            }
            if (existsSync(this.configFile)) {
                this.configCache = JSON.parse(readFileSync(this.configFile, 'utf-8'));
            }
        }
        catch (error) {
            console.error('Failed to load data:', error);
        }
    }
    reviveTask(obj) {
        return {
            ...obj,
            createdAt: new Date(obj.createdAt),
            updatedAt: new Date(obj.updatedAt),
            dueDate: obj.dueDate ? new Date(obj.dueDate) : undefined,
            completedAt: obj.completedAt ? new Date(obj.completedAt) : undefined,
        };
    }
    reviveProject(obj) {
        return {
            ...obj,
            createdAt: new Date(obj.createdAt),
            updatedAt: new Date(obj.updatedAt),
        };
    }
    scheduleSave() {
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.flush(), 500);
    }
    flush() {
        if (!this.dirty)
            return;
        try {
            writeFileSync(this.tasksFile, JSON.stringify(Array.from(this.cache.values()), null, 2));
            writeFileSync(this.projectsFile, JSON.stringify(Array.from(this.projectCache.values()), null, 2));
            if (this.configCache) {
                writeFileSync(this.configFile, JSON.stringify(this.configCache, null, 2));
            }
            this.dirty = false;
            this.emit('saved');
        }
        catch (error) {
            console.error('Failed to save data:', error);
            this.emit('error', error);
        }
    }
    // Task operations
    getTask(id) {
        return this.cache.get(id);
    }
    getAllTasks() {
        return Array.from(this.cache.values());
    }
    createTask(task) {
        const now = new Date();
        const newTask = {
            ...task,
            id: generateId(),
            createdAt: now,
            updatedAt: now,
            timeSpent: 0,
        };
        this.cache.set(newTask.id, newTask);
        this.dirty = true;
        this.scheduleSave();
        this.emit('taskCreated', newTask);
        return newTask;
    }
    updateTask(id, updates) {
        const task = this.cache.get(id);
        if (!task)
            return null;
        const updated = {
            ...task,
            ...updates,
            id: task.id,
            createdAt: task.createdAt,
            updatedAt: new Date(),
        };
        if (updates.status === 'completed' && task.status !== 'completed') {
            updated.completedAt = new Date();
        }
        this.cache.set(id, updated);
        this.dirty = true;
        this.scheduleSave();
        this.emit('taskUpdated', updated);
        return updated;
    }
    deleteTask(id) {
        const deleted = this.cache.delete(id);
        if (deleted) {
            this.dirty = true;
            this.scheduleSave();
            this.emit('taskDeleted', id);
        }
        return deleted;
    }
    // Project operations
    getProject(id) {
        return this.projectCache.get(id);
    }
    getAllProjects() {
        return Array.from(this.projectCache.values());
    }
    createProject(project) {
        const now = new Date();
        const newProject = {
            ...project,
            id: generateId(),
            createdAt: now,
            updatedAt: now,
            taskIds: [],
        };
        this.projectCache.set(newProject.id, newProject);
        this.dirty = true;
        this.scheduleSave();
        this.emit('projectCreated', newProject);
        return newProject;
    }
    updateProject(id, updates) {
        const project = this.projectCache.get(id);
        if (!project)
            return null;
        const updated = {
            ...project,
            ...updates,
            id: project.id,
            createdAt: project.createdAt,
            updatedAt: new Date(),
        };
        this.projectCache.set(id, updated);
        this.dirty = true;
        this.scheduleSave();
        this.emit('projectUpdated', updated);
        return updated;
    }
    deleteProject(id) {
        const deleted = this.projectCache.delete(id);
        if (deleted) {
            // Unassign tasks from this project
            for (const task of this.cache.values()) {
                if (task.projectId === id) {
                    task.projectId = undefined;
                    task.updatedAt = new Date();
                }
            }
            this.dirty = true;
            this.scheduleSave();
            this.emit('projectDeleted', id);
        }
        return deleted;
    }
    // Config operations
    getConfig() {
        if (!this.configCache) {
            this.configCache = this.getDefaultConfig();
        }
        return this.configCache;
    }
    updateConfig(updates) {
        this.configCache = { ...this.getConfig(), ...updates };
        this.dirty = true;
        this.scheduleSave();
        this.emit('configUpdated', this.configCache);
        return this.configCache;
    }
    getDefaultConfig() {
        return {
            dataDir: this.dataDir,
            defaultProject: '',
            autoSave: true,
            theme: 'auto',
            notifications: true,
            editor: process.env.EDITOR || 'vim',
            dateFormat: 'YYYY-MM-DD',
            timeFormat: '24h',
        };
    }
    // Query operations
    queryTasks(filter = {}, sort = { field: 'createdAt', direction: 'desc' }) {
        let tasks = this.getAllTasks();
        // Apply filters
        if (filter.status?.length) {
            tasks = tasks.filter(t => filter.status.includes(t.status));
        }
        if (filter.priority?.length) {
            tasks = tasks.filter(t => filter.priority.includes(t.priority));
        }
        if (filter.tags?.length) {
            tasks = tasks.filter(t => filter.tags.some(tag => t.tags.includes(tag)));
        }
        if (filter.projectId) {
            tasks = tasks.filter(t => t.projectId === filter.projectId);
        }
        if (filter.search) {
            const search = filter.search.toLowerCase();
            tasks = tasks.filter(t => t.title.toLowerCase().includes(search) ||
                t.description.toLowerCase().includes(search) ||
                t.tags.some(tag => tag.toLowerCase().includes(search)));
        }
        if (filter.dueBefore) {
            tasks = tasks.filter(t => t.dueDate && t.dueDate <= filter.dueBefore);
        }
        if (filter.dueAfter) {
            tasks = tasks.filter(t => t.dueDate && t.dueDate >= filter.dueAfter);
        }
        // Apply sorting
        tasks.sort((a, b) => {
            let aVal;
            let bVal;
            if (sort.field === 'priority') {
                aVal = priorityWeight(a.priority);
                bVal = priorityWeight(b.priority);
            }
            else if (sort.field === 'status') {
                aVal = statusWeight(a.status);
                bVal = statusWeight(b.status);
            }
            else {
                aVal = a[sort.field];
                bVal = b[sort.field];
            }
            if (aVal instanceof Date && bVal instanceof Date) {
                aVal = aVal.getTime();
                bVal = bVal.getTime();
            }
            let cmp;
            if (typeof aVal === 'number' && typeof bVal === 'number') {
                cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
            }
            else if (typeof aVal === 'string' && typeof bVal === 'string') {
                cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
            }
            else {
                cmp = String(aVal) < String(bVal) ? -1 : String(aVal) > String(bVal) ? 1 : 0;
            }
            return sort.direction === 'asc' ? cmp : -cmp;
        });
        return tasks;
    }
    // Statistics
    getStats() {
        const tasks = this.getAllTasks();
        const now = new Date();
        return {
            total: tasks.length,
            byStatus: {
                pending: tasks.filter(t => t.status === 'pending').length,
                in_progress: tasks.filter(t => t.status === 'in_progress').length,
                blocked: tasks.filter(t => t.status === 'blocked').length,
                completed: tasks.filter(t => t.status === 'completed').length,
                archived: tasks.filter(t => t.status === 'archived').length,
            },
            byPriority: {
                low: tasks.filter(t => t.priority === 'low').length,
                medium: tasks.filter(t => t.priority === 'medium').length,
                high: tasks.filter(t => t.priority === 'high').length,
                critical: tasks.filter(t => t.priority === 'critical').length,
            },
            overdue: tasks.filter(t => t.dueDate && t.dueDate < now && t.status !== 'completed').length,
            dueToday: tasks.filter(t => t.dueDate &&
                t.dueDate.toDateString() === now.toDateString() && t.status !== 'completed').length,
            totalTimeEstimate: tasks.reduce((sum, t) => sum + (t.timeEstimate || 0), 0),
            totalTimeSpent: tasks.reduce((sum, t) => sum + t.timeSpent, 0),
            completionRate: tasks.length > 0
                ? tasks.filter(t => t.status === 'completed').length / tasks.length * 100
                : 0,
        };
    }
    // Export/Import
    export(options) {
        let tasks = this.queryTasks(options.filter || {});
        if (!options.includeCompleted) {
            tasks = tasks.filter(t => t.status !== 'completed');
        }
        if (!options.includeArchived) {
            tasks = tasks.filter(t => t.status !== 'archived');
        }
        switch (options.format) {
            case 'json':
                return JSON.stringify(tasks, null, 2);
            case 'csv':
                return this.exportCSV(tasks);
            case 'markdown':
                return this.exportMarkdown(tasks);
            case 'html':
                return this.exportHTML(tasks);
            default:
                return JSON.stringify(tasks, null, 2);
        }
    }
    exportCSV(tasks) {
        const headers = ['ID', 'Title', 'Description', 'Status', 'Priority', 'Tags', 'Project', 'Created', 'Updated', 'Due', 'Completed', 'Estimate (min)', 'Spent (min)'];
        const rows = tasks.map(t => [
            t.id,
            `"${t.title.replace(/"/g, '""')}"`,
            `"${t.description.replace(/"/g, '""')}"`,
            t.status,
            t.priority,
            t.tags.join(';'),
            t.projectId || '',
            formatDate(t.createdAt),
            formatDate(t.updatedAt),
            t.dueDate ? formatDate(t.dueDate) : '',
            t.completedAt ? formatDate(t.completedAt) : '',
            t.timeEstimate || '',
            t.timeSpent,
        ].join(','));
        return [headers.join(','), ...rows].join('\n');
    }
    exportMarkdown(tasks) {
        const lines = ['# Task Export', '', `Generated: ${new Date().toISOString()}`, '', '## Tasks', ''];
        for (const task of tasks) {
            lines.push(`### ${task.title} \`${task.id}\``);
            lines.push(`- **Status**: ${task.status}`);
            lines.push(`- **Priority**: ${task.priority}`);
            lines.push(`- **Tags**: ${task.tags.join(', ') || 'none'}`);
            lines.push(`- **Project**: ${task.projectId || 'none'}`);
            lines.push(`- **Created**: ${formatDate(task.createdAt)}`);
            if (task.dueDate)
                lines.push(`- **Due**: ${formatDate(task.dueDate)}`);
            if (task.completedAt)
                lines.push(`- **Completed**: ${formatDate(task.completedAt)}`);
            if (task.timeEstimate)
                lines.push(`- **Estimate**: ${formatDuration(task.timeEstimate)}`);
            lines.push(`- **Time Spent**: ${formatDuration(task.timeSpent)}`);
            lines.push('');
            if (task.description) {
                lines.push(task.description);
                lines.push('');
            }
            lines.push('---');
            lines.push('');
        }
        return lines.join('\n');
    }
    exportHTML(tasks) {
        const style = `
      <style>
        body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
        .task { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
        .task-header { display: flex; gap: 1rem; align-items: center; margin-bottom: 0.5rem; }
        .badge { padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.875rem; font-weight: 500; }
        .status-pending { background: #fff3cd; color: #856404; }
        .status-in_progress { background: #cce5ff; color: #004085; }
        .status-blocked { background: #f8d7da; color: #721c24; }
        .status-completed { background: #d4edda; color: #155724; }
        .status-archived { background: #e2e3e5; color: #383d41; }
        .priority-low { background: #e2e3e5; color: #383d41; }
        .priority-medium { background: #cce5ff; color: #004085; }
        .priority-high { background: #fff3cd; color: #856404; }
        .priority-critical { background: #f8d7da; color: #721c24; }
        .meta { color: #666; font-size: 0.875rem; }
        .description { white-space: pre-wrap; margin-top: 0.5rem; }
      </style>
    `;
        const taskHtml = tasks.map(t => `
      <div class="task">
        <div class="task-header">
          <h3>${t.title} <code>${t.id}</code></h3>
          <span class="badge status-${t.status}">${t.status}</span>
          <span class="badge priority-${t.priority}">${t.priority}</span>
        </div>
        <div class="meta">
          ${t.tags.length ? `<span>Tags: ${t.tags.join(', ')}</span>` : ''}
          ${t.projectId ? `<span>Project: ${t.projectId}</span>` : ''}
          <span>Created: ${formatDate(t.createdAt)}</span>
          ${t.dueDate ? `<span>Due: ${formatDate(t.dueDate)}</span>` : ''}
          ${t.completedAt ? `<span>Completed: ${formatDate(t.completedAt)}</span>` : ''}
          ${t.timeEstimate ? `<span>Estimate: ${formatDuration(t.timeEstimate)}</span>` : ''}
          <span>Time Spent: ${formatDuration(t.timeSpent)}</span>
        </div>
        ${t.description ? `<div class="description">${t.description}</div>` : ''}
      </div>
    `).join('');
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Task Export</title>${style}</head><body><h1>Task Export</h1><p>Generated: ${new Date().toISOString()}</p>${taskHtml}</body></html>`;
    }
    importTasks(json) {
        let data;
        try {
            data = JSON.parse(json);
        }
        catch {
            return { created: 0, updated: 0, errors: ['Invalid JSON'] };
        }
        const errors = [];
        let created = 0, updated = 0;
        for (const task of data) {
            try {
                if (!task.id || !task.title) {
                    errors.push(`Skipping invalid task: missing id or title`);
                    continue;
                }
                const existing = this.cache.get(task.id);
                const revived = this.reviveTask(task);
                if (existing) {
                    this.cache.set(task.id, revived);
                    updated++;
                }
                else {
                    this.cache.set(task.id, revived);
                    created++;
                }
            }
            catch (e) {
                errors.push(`Error importing task ${task.id}: ${e}`);
            }
        }
        if (created + updated > 0) {
            this.dirty = true;
            this.scheduleSave();
        }
        return { created, updated, errors };
    }
    shutdown() {
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.flush();
    }
}
// ============================================================================
// CLI Output Formatting
// ============================================================================
class OutputFormatter {
    theme;
    useColor;
    constructor(theme = 'auto') {
        this.theme = theme;
        this.useColor = this.shouldUseColor();
    }
    shouldUseColor() {
        if (this.theme === 'light' || this.theme === 'dark')
            return true;
        return process.stdout.isTTY && !process.env.NO_COLOR;
    }
    color(code) {
        return this.useColor ? `\x1b[${code}m` : '';
    }
    reset() {
        return this.color('0');
    }
    // Color helpers
    red = (s) => `${this.color('31')}${s}${this.reset()}`;
    green = (s) => `${this.color('32')}${s}${this.reset()}`;
    yellow = (s) => `${this.color('33')}${s}${this.reset()}`;
    blue = (s) => `${this.color('34')}${s}${this.reset()}`;
    magenta = (s) => `${this.color('35')}${s}${this.reset()}`;
    cyan = (s) => `${this.color('36')}${s}${this.reset()}`;
    gray = (s) => `${this.color('90')}${s}${this.reset()}`;
    bold = (s) => `${this.color('1')}${s}${this.reset()}`;
    dim = (s) => `${this.color('2')}${s}${this.reset()}`;
    // Status colors
    statusColor(status) {
        const colors = {
            pending: this.yellow,
            in_progress: this.blue,
            blocked: this.red,
            completed: this.green,
            archived: this.gray,
        };
        return colors[status] ? colors[status](status) : status;
    }
    priorityColor(priority) {
        const colors = {
            low: this.gray,
            medium: this.blue,
            high: this.yellow,
            critical: this.red,
        };
        return colors[priority] ? colors[priority](priority) : priority;
    }
    formatTask(task, verbose = false) {
        const lines = [];
        // Header line
        const statusBadge = this.statusColor(task.status);
        const priorityBadge = this.priorityColor(task.priority);
        const id = this.gray(`[${task.id}]`);
        lines.push(`${this.bold(task.title)} ${id} ${statusBadge} ${priorityBadge}`);
        if (verbose) {
            if (task.description) {
                lines.push(`  ${this.dim('Description:')} ${task.description}`);
            }
            if (task.tags.length) {
                lines.push(`  ${this.dim('Tags:')} ${task.tags.map(t => this.cyan(`#${t}`)).join(' ')}`);
            }
            if (task.projectId) {
                lines.push(`  ${this.dim('Project:')} ${this.magenta(task.projectId)}`);
            }
            if (task.dueDate) {
                const now = new Date();
                const isOverdue = task.dueDate < now && task.status !== 'completed';
                const dueStr = formatDate(task.dueDate);
                lines.push(`  ${this.dim('Due:')} ${isOverdue ? this.red(dueStr + ' (OVERDUE)') : dueStr}`);
            }
            if (task.timeEstimate) {
                lines.push(`  ${this.dim('Estimate:')} ${formatDuration(task.timeEstimate)}`);
            }
            lines.push(`  ${this.dim('Time Spent:')} ${formatDuration(task.timeSpent)}`);
            lines.push(`  ${this.dim('Created:')} ${formatDate(task.createdAt)}`);
            if (task.completedAt) {
                lines.push(`  ${this.dim('Completed:')} ${formatDate(task.completedAt)}`);
            }
            if (task.dependencies.length) {
                lines.push(`  ${this.dim('Depends on:')} ${task.dependencies.join(', ')}`);
            }
        }
        return lines.join('\n');
    }
    formatTaskList(tasks, verbose = false) {
        if (tasks.length === 0) {
            return this.dim('No tasks found.');
        }
        return tasks.map(t => this.formatTask(t, verbose)).join('\n\n');
    }
    formatProject(project, taskCount) {
        return `${this.bold(project.name)} ${this.gray(`[${project.id}]`)} ${this.dim(`(${taskCount} tasks)`)}
  ${this.dim(project.description || 'No description')}
  ${this.dim(`Created: ${formatDate(project.createdAt)}`)}`;
    }
    formatStats(stats) {
        const lines = [
            this.bold('Task Statistics'),
            '',
            `  Total: ${this.bold(String(stats.total))}`,
            `  Completed: ${this.green(String(stats.byStatus.completed))} (${stats.completionRate.toFixed(1)}%)`,
            `  In Progress: ${this.blue(String(stats.byStatus.in_progress))}`,
            `  Pending: ${this.yellow(String(stats.byStatus.pending))}`,
            `  Blocked: ${this.red(String(stats.byStatus.blocked))}`,
            `  Archived: ${this.gray(String(stats.byStatus.archived))}`,
            '',
            `  Critical: ${this.red(String(stats.byPriority.critical))}`,
            `  High: ${this.yellow(String(stats.byPriority.high))}`,
            `  Medium: ${this.blue(String(stats.byPriority.medium))}`,
            `  Low: ${this.gray(String(stats.byPriority.low))}`,
            '',
            `  Overdue: ${stats.overdue > 0 ? this.red(String(stats.overdue)) : '0'}`,
            `  Due Today: ${stats.dueToday > 0 ? this.yellow(String(stats.dueToday)) : '0'}`,
            '',
            `  Time Estimated: ${formatDuration(stats.totalTimeEstimate)}`,
            `  Time Spent: ${formatDuration(stats.totalTimeSpent)}`,
        ];
        return lines.join('\n');
    }
    formatError(message) {
        return this.red(`Error: ${message}`);
    }
    formatSuccess(message) {
        return this.green(`✓ ${message}`);
    }
    formatWarning(message) {
        return this.yellow(`⚠ ${message}`);
    }
    formatInfo(message) {
        return this.blue(`ℹ ${message}`);
    }
}
// ============================================================================
// Command Handlers
// ============================================================================
class TaskCommands {
    storage;
    output;
    constructor(storage, output) {
        this.storage = storage;
        this.output = output;
    }
    create(title, options) {
        const dueDate = options.due ? parseDate(options.due) ?? undefined : undefined;
        if (options.due && !dueDate) {
            console.error(this.output.formatError('Invalid date format. Use YYYY-MM-DD, "today", "tomorrow", or "next-week"'));
            process.exit(1);
        }
        const projectId = options.project || this.storage.getConfig().defaultProject || undefined;
        const task = this.storage.createTask({
            title,
            description: options.description || '',
            status: 'pending',
            priority: options.priority || 'medium',
            tags: options.tags || [],
            projectId,
            dueDate,
            timeEstimate: options.estimate,
            dependencies: options.depends || [],
            metadata: {},
        });
        console.log(this.output.formatSuccess(`Created task: ${task.title} [${task.id}]`));
        console.log(this.output.formatTask(task, true));
    }
    list(options) {
        const filter = {};
        if (options.status?.length)
            filter.status = options.status;
        if (options.priority?.length)
            filter.priority = options.priority;
        if (options.tags?.length)
            filter.tags = options.tags;
        if (options.project)
            filter.projectId = options.project;
        if (options.search)
            filter.search = options.search;
        if (options.dueBefore) {
            const date = parseDate(options.dueBefore);
            if (date)
                filter.dueBefore = date;
        }
        if (options.dueAfter) {
            const date = parseDate(options.dueAfter);
            if (date)
                filter.dueAfter = date;
        }
        const sortField = options.sort || 'createdAt';
        const sort = {
            field: ['createdAt', 'updatedAt', 'dueDate', 'priority', 'title', 'timeSpent'].includes(sortField)
                ? sortField : 'createdAt',
            direction: options.order || 'desc',
        };
        let tasks = this.storage.queryTasks(filter, sort);
        if (options.limit && options.limit > 0) {
            tasks = tasks.slice(0, options.limit);
        }
        console.log(this.output.formatTaskList(tasks, options.verbose));
    }
    show(id) {
        const task = this.storage.getTask(id);
        if (!task) {
            console.error(this.output.formatError(`Task not found: ${id}`));
            process.exit(1);
        }
        console.log(this.output.formatTask(task, true));
    }
    update(id, options) {
        const task = this.storage.getTask(id);
        if (!task) {
            console.error(this.output.formatError(`Task not found: ${id}`));
            process.exit(1);
        }
        const updates = {};
        if (options.title)
            updates.title = options.title;
        if (options.description)
            updates.description = options.description;
        if (options.status)
            updates.status = options.status;
        if (options.priority)
            updates.priority = options.priority;
        if (options.project)
            updates.projectId = options.project;
        if (options.estimate !== undefined)
            updates.timeEstimate = options.estimate;
        if (options.due) {
            const dueDate = parseDate(options.due);
            if (!dueDate) {
                console.error(this.output.formatError('Invalid date format'));
                process.exit(1);
            }
            updates.dueDate = dueDate;
        }
        if (options.tags) {
            updates.tags = options.tags;
        }
        else if (options.addTag) {
            updates.tags = [...new Set([...task.tags, options.addTag])];
        }
        else if (options.removeTag) {
            updates.tags = task.tags.filter(t => t !== options.removeTag);
        }
        if (options.addDependency) {
            updates.dependencies = [...new Set([...task.dependencies, options.addDependency])];
        }
        else if (options.removeDependency) {
            updates.dependencies = task.dependencies.filter(d => d !== options.removeDependency);
        }
        if (options.logTime) {
            updates.timeSpent = task.timeSpent + options.logTime;
        }
        const updated = this.storage.updateTask(id, updates);
        if (updated) {
            console.log(this.output.formatSuccess(`Updated task: ${updated.title}`));
            console.log(this.output.formatTask(updated, true));
        }
    }
    delete(id, force = false) {
        const task = this.storage.getTask(id);
        if (!task) {
            console.error(this.output.formatError(`Task not found: ${id}`));
            process.exit(1);
        }
        if (!force) {
            console.log(this.output.formatWarning(`About to delete: ${task.title} [${id}]`));
            console.log(this.output.dim('Use --force to confirm'));
            process.exit(1);
        }
        this.storage.deleteTask(id);
        console.log(this.output.formatSuccess(`Deleted task: ${task.title}`));
    }
    start(id) {
        this.update(id, { status: 'in_progress' });
    }
    complete(id) {
        this.update(id, { status: 'completed' });
    }
    block(id, reason) {
        const task = this.storage.getTask(id);
        if (!task)
            return;
        this.update(id, {
            status: 'blocked',
            description: reason ? `${task.description}\n\nBlocked: ${reason}` : task.description
        });
    }
    archive(id) {
        this.update(id, { status: 'archived' });
    }
    stats() {
        const stats = this.storage.getStats();
        console.log(this.output.formatStats(stats));
    }
    // Time tracking
    logTime(id, minutes) {
        const task = this.storage.getTask(id);
        if (!task) {
            console.error(this.output.formatError(`Task not found: ${id}`));
            process.exit(1);
        }
        const updated = this.storage.updateTask(id, { timeSpent: task.timeSpent + minutes });
        if (updated) {
            console.log(this.output.formatSuccess(`Logged ${formatDuration(minutes)} to ${updated.title}`));
            console.log(this.output.formatInfo(`Total time spent: ${formatDuration(updated.timeSpent)}`));
        }
    }
    timer(id) {
        const task = this.storage.getTask(id);
        if (!task) {
            console.error(this.output.formatError(`Task not found: ${id}`));
            process.exit(1);
        }
        console.log(this.output.formatInfo(`Starting timer for: ${task.title}`));
        console.log(this.output.dim('Press Ctrl+C to stop'));
        const startTime = Date.now();
        let interval;
        const updateDisplay = () => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000 / 60);
            process.stdout.write(`\r${this.output.cyan('⏱')} Elapsed: ${formatDuration(elapsed)}  `);
        };
        interval = setInterval(updateDisplay, 1000);
        updateDisplay();
        process.on('SIGINT', () => {
            clearInterval(interval);
            const totalMinutes = Math.floor((Date.now() - startTime) / 1000 / 60);
            if (totalMinutes > 0) {
                this.storage.updateTask(id, { timeSpent: task.timeSpent + totalMinutes });
                console.log('\n' + this.output.formatSuccess(`Logged ${formatDuration(totalMinutes)}`));
            }
            else {
                console.log('\n' + this.output.formatInfo('Timer stopped (less than 1 minute)'));
            }
            process.exit(0);
        });
    }
}
class ProjectCommands {
    storage;
    output;
    constructor(storage, output) {
        this.storage = storage;
        this.output = output;
    }
    create(name, options) {
        const project = this.storage.createProject({
            name,
            description: options.description || '',
            color: options.color || '#3b82f6',
            metadata: {},
        });
        console.log(this.output.formatSuccess(`Created project: ${project.name} [${project.id}]`));
    }
    list() {
        const projects = this.storage.getAllProjects();
        if (projects.length === 0) {
            console.log(this.output.dim('No projects found.'));
            return;
        }
        for (const project of projects) {
            const taskCount = this.storage.getAllTasks().filter(t => t.projectId === project.id).length;
            console.log(this.output.formatProject(project, taskCount));
            console.log('');
        }
    }
    show(id) {
        const project = this.storage.getProject(id);
        if (!project) {
            console.error(this.output.formatError(`Project not found: ${id}`));
            process.exit(1);
        }
        const tasks = this.storage.getAllTasks().filter(t => t.projectId === id);
        console.log(this.output.formatProject(project, tasks.length));
        console.log('');
        if (tasks.length > 0) {
            console.log(this.output.bold('Tasks:'));
            console.log(this.output.formatTaskList(tasks));
        }
    }
    update(id, options) {
        const project = this.storage.updateProject(id, options);
        if (!project) {
            console.error(this.output.formatError(`Project not found: ${id}`));
            process.exit(1);
        }
        console.log(this.output.formatSuccess(`Updated project: ${project.name}`));
    }
    delete(id, force = false) {
        const project = this.storage.getProject(id);
        if (!project) {
            console.error(this.output.formatError(`Project not found: ${id}`));
            process.exit(1);
        }
        if (!force) {
            console.log(this.output.formatWarning(`About to delete project: ${project.name}`));
            console.log(this.output.dim('Use --force to confirm'));
            process.exit(1);
        }
        this.storage.deleteProject(id);
        console.log(this.output.formatSuccess(`Deleted project: ${project.name}`));
    }
    setDefault(id) {
        const project = this.storage.getProject(id);
        if (!project) {
            console.error(this.output.formatError(`Project not found: ${id}`));
            process.exit(1);
        }
        this.storage.updateConfig({ defaultProject: id });
        console.log(this.output.formatSuccess(`Default project set to: ${project.name}`));
    }
}
class ConfigCommands {
    storage;
    output;
    constructor(storage, output) {
        this.storage = storage;
        this.output = output;
    }
    show() {
        const config = this.storage.getConfig();
        console.log(this.output.bold('Configuration:'));
        console.log('');
        for (const [key, value] of Object.entries(config)) {
            console.log(`  ${this.output.cyan(key)}: ${typeof value === 'string' ? this.output.green(value) : value}`);
        }
    }
    set(key, value) {
        const config = this.storage.getConfig();
        const typedKey = key;
        if (!(typedKey in config)) {
            console.error(this.output.formatError(`Unknown config key: ${key}`));
            console.log(this.output.dim('Available keys: ' + Object.keys(config).join(', ')));
            process.exit(1);
        }
        // Type conversion
        let parsedValue = value;
        const currentValue = config[typedKey];
        if (typeof currentValue === 'boolean') {
            parsedValue = value === 'true' || value === '1';
        }
        else if (typeof currentValue === 'number') {
            parsedValue = Number(value);
            if (isNaN(parsedValue)) {
                console.error(this.output.formatError('Invalid number'));
                process.exit(1);
            }
        }
        this.storage.updateConfig({ [typedKey]: parsedValue });
        console.log(this.output.formatSuccess(`Set ${key} = ${parsedValue}`));
    }
    reset() {
        const defaultConfig = this.storage.getConfig(); // This will recreate defaults
        // Actually reset by updating with defaults
        this.storage.updateConfig(defaultConfig);
        console.log(this.output.formatSuccess('Configuration reset to defaults'));
    }
    edit() {
        const editor = this.storage.getConfig().editor;
        const configFile = join(this.storage.getConfig().dataDir, 'config.json');
        console.log(this.output.formatInfo(`Opening ${configFile} in ${editor}...`));
        const child = spawn(editor, [configFile], { stdio: 'inherit' });
        child.on('exit', (code) => {
            if (code === 0) {
                this.storage.load(); // Reload config
                console.log(this.output.formatSuccess('Configuration updated'));
            }
            else {
                console.error(this.output.formatError(`Editor exited with code ${code}`));
            }
        });
    }
}
class ExportImportCommands {
    storage;
    output;
    constructor(storage, output) {
        this.storage = storage;
        this.output = output;
    }
    export(options) {
        const output = this.storage.export(options);
        if (options.format === 'json' || options.format === 'csv') {
            console.log(output);
        }
        else {
            // For markdown/html, could write to file
            console.log(output);
        }
    }
    import(filePath, dryRun = false) {
        if (!existsSync(filePath)) {
            console.error(this.output.formatError(`File not found: ${filePath}`));
            process.exit(1);
        }
        const content = readFileSync(filePath, 'utf-8');
        if (dryRun) {
            console.log(this.output.formatInfo('Dry run - no changes will be made'));
            // Parse and validate only
            try {
                const data = JSON.parse(content);
                console.log(this.output.formatInfo(`Would import ${data.length} tasks`));
            }
            catch {
                console.error(this.output.formatError('Invalid JSON'));
                process.exit(1);
            }
            return;
        }
        const result = this.storage.importTasks(content);
        if (result.created > 0) {
            console.log(this.output.formatSuccess(`Created ${result.created} tasks`));
        }
        if (result.updated > 0) {
            console.log(this.output.formatInfo(`Updated ${result.updated} tasks`));
        }
        if (result.errors.length > 0) {
            for (const error of result.errors) {
                console.error(this.output.formatError(error));
            }
        }
    }
}
// ============================================================================
// Main CLI Setup
// ============================================================================
function createCLI() {
    const program = new Command();
    // Initialize storage
    const dataDir = process.env.TASKFLOW_DATA_DIR || join(os.homedir(), '.taskflow');
    const storage = new Storage(dataDir);
    const config = storage.getConfig();
    const output = new OutputFormatter(config.theme);
    // Command instances
    const taskCmds = new TaskCommands(storage, output);
    const projectCmds = new ProjectCommands(storage, output);
    const configCmds = new ConfigCommands(storage, output);
    const exportImportCmds = new ExportImportCommands(storage, output);
    program
        .name('taskflow')
        .description('A powerful task management CLI')
        .version('1.0.0')
        .hook('postAction', () => storage.shutdown());
    // Global options
    program
        .option('-v, --verbose', 'Verbose output')
        .option('--no-color', 'Disable colored output')
        .option('--data-dir <path>', 'Data directory', dataDir);
    // ============================================================
    // Task Commands
    // ============================================================
    const task = program
        .command('task')
        .alias('t')
        .description('Task management commands');
    task
        .command('create <title>')
        .alias('add')
        .description('Create a new task')
        .option('-d, --description <text>', 'Task description')
        .option('-p, --priority <level>', 'Priority: low, medium, high, critical', 'medium')
        .option('--tags <tags...>', 'Tags')
        .option('--project <id>', 'Project ID')
        .option('--due <date>', 'Due date (YYYY-MM-DD, today, tomorrow, next-week)')
        .option('--estimate <minutes>', 'Time estimate in minutes', parseInt)
        .option('--depends <ids...>', 'Dependency task IDs')
        .action((title, options) => taskCmds.create(title, options));
    task
        .command('list')
        .alias('ls')
        .description('List tasks')
        .option('-s, --status <statuses...>', 'Filter by status')
        .option('-p, --priority <priorities...>', 'Filter by priority')
        .option('--tags <tags...>', 'Filter by tags')
        .option('--project <id>', 'Filter by project')
        .option('--search <text>', 'Search in title/description/tags')
        .option('--due-before <date>', 'Due before date')
        .option('--due-after <date>', 'Due after date')
        .option('--sort <field>', 'Sort field: createdAt, updatedAt, dueDate, priority, title, timeSpent', 'createdAt')
        .option('--order <direction>', 'Sort order: asc, desc', 'desc')
        .option('-v, --verbose', 'Verbose output')
        .option('-l, --limit <number>', 'Limit results', parseInt)
        .action((options) => taskCmds.list(options));
    task
        .command('show <id>')
        .alias('get')
        .description('Show task details')
        .action((id) => taskCmds.show(id));
    task
        .command('update <id>')
        .alias('edit')
        .description('Update a task')
        .option('--title <text>', 'New title')
        .option('--description <text>', 'New description')
        .option('-s, --status <status>', 'New status: pending, in_progress, blocked, completed, archived')
        .option('-p, --priority <priority>', 'New priority: low, medium, high, critical')
        .option('--tags <tags...>', 'Replace all tags')
        .option('--add-tag <tag>', 'Add a tag')
        .option('--remove-tag <tag>', 'Remove a tag')
        .option('--project <id>', 'Set project')
        .option('--due <date>', 'Set due date')
        .option('--estimate <minutes>', 'Set time estimate', parseInt)
        .option('--add-dep <id>', 'Add dependency')
        .option('--remove-dep <id>', 'Remove dependency')
        .option('--log-time <minutes>', 'Log time spent', parseInt)
        .action((id, options) => taskCmds.update(id, options));
    task
        .command('delete <id>')
        .alias('rm')
        .description('Delete a task')
        .option('-f, --force', 'Force deletion without confirmation')
        .action((id, options) => taskCmds.delete(id, options.force));
    task
        .command('start <id>')
        .description('Mark task as in progress')
        .action((id) => taskCmds.start(id));
    task
        .command('complete <id>')
        .alias('done')
        .description('Mark task as completed')
        .action((id) => taskCmds.complete(id));
    task
        .command('block <id>')
        .description('Mark task as blocked')
        .option('-r, --reason <text>', 'Reason for blocking')
        .action((id, options) => taskCmds.block(id, options.reason));
    task
        .command('archive <id>')
        .description('Archive a task')
        .action((id) => taskCmds.archive(id));
    task
        .command('stats')
        .description('Show task statistics')
        .action(() => taskCmds.stats());
    task
        .command('log-time <id> <minutes>')
        .description('Log time spent on a task')
        .action((id, minutes) => taskCmds.logTime(id, parseInt(minutes)));
    task
        .command('timer <id>')
        .description('Start a timer for a task')
        .action((id) => taskCmds.timer(id));
    // ============================================================
    // Project Commands
    // ============================================================
    const project = program
        .command('project')
        .alias('p')
        .description('Project management commands');
    project
        .command('create <name>')
        .alias('add')
        .description('Create a new project')
        .option('-d, --description <text>', 'Project description')
        .option('-c, --color <hex>', 'Project color (hex)', '#3b82f6')
        .action((name, options) => projectCmds.create(name, options));
    project
        .command('list')
        .alias('ls')
        .description('List all projects')
        .action(() => projectCmds.list());
    project
        .command('show <id>')
        .alias('get')
        .description('Show project with tasks')
        .action((id) => projectCmds.show(id));
    project
        .command('update <id>')
        .alias('edit')
        .description('Update a project')
        .option('--name <text>', 'New name')
        .option('--description <text>', 'New description')
        .option('--color <hex>', 'New color')
        .action((id, options) => projectCmds.update(id, options));
    project
        .command('delete <id>')
        .alias('rm')
        .description('Delete a project')
        .option('-f, --force', 'Force deletion')
        .action((id, options) => projectCmds.delete(id, options.force));
    project
        .command('set-default <id>')
        .description('Set default project for new tasks')
        .action((id) => projectCmds.setDefault(id));
    // ============================================================
    // Config Commands
    // ============================================================
    const configCmd = program
        .command('config')
        .alias('cfg')
        .description('Configuration commands');
    configCmd
        .command('show')
        .description('Show current configuration')
        .action(() => configCmds.show());
    configCmd
        .command('set <key> <value>')
        .description('Set a configuration value')
        .action((key, value) => configCmds.set(key, value));
    configCmd
        .command('reset')
        .description('Reset configuration to defaults')
        .action(() => configCmds.reset());
    configCmd
        .command('edit')
        .description('Edit configuration in $EDITOR')
        .action(() => configCmds.edit());
    // ============================================================
    // Export/Import Commands
    // ============================================================
    const exportCmd = program
        .command('export')
        .description('Export tasks')
        .option('-f, --format <format>', 'Format: json, csv, markdown, html', 'json')
        .option('--include-completed', 'Include completed tasks', true)
        .option('--include-archived', 'Include archived tasks', false)
        .option('--status <statuses...>', 'Filter by status')
        .option('--project <id>', 'Filter by project')
        .option('-o, --output <file>', 'Output file (stdout if omitted)')
        .action((options) => {
        const exportOptions = {
            format: options.format,
            includeCompleted: options.includeCompleted,
            includeArchived: options.includeArchived,
            filter: {
                status: options.status,
                projectId: options.project,
            },
        };
        const exported = storage.export(exportOptions);
        if (options.output) {
            writeFileSync(options.output, exported);
            console.log(output.formatSuccess(`Exported to ${options.output}`));
        }
        else {
            console.log(exported);
        }
    });
    const importCmd = program
        .command('import <file>')
        .description('Import tasks from JSON')
        .option('--dry-run', 'Validate without importing')
        .action((file, options) => exportImportCmds.import(file, options.dryRun));
    // ============================================================
    // Shell Completion
    // ============================================================
    program
        .command('completion <shell>')
        .description('Generate shell completion script')
        .action((shell) => {
        if (shell === 'bash' || shell === 'zsh' || shell === 'fish') {
            console.log(`# Add to your .${shell}rc:\n`);
            console.log(`eval "$(taskflow completion ${shell})"`);
        }
        else {
            console.error(output.formatError('Supported shells: bash, zsh, fish'));
        }
    });
    return program;
}
// ============================================================================
// Entry Point
// ============================================================================
async function main() {
    const program = createCLI();
    try {
        await program.parseAsync(process.argv);
    }
    catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=cli.js.map