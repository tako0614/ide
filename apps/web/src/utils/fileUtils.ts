/**
 * File and tree manipulation utilities
 */

import type { FileSystemEntry, FileTreeNode } from '../types';
import { getLanguageFromPath as sharedGetLanguageFromPath } from '@deck-ide/shared/utils';

/**
 * Converts FileSystemEntry array to FileTreeNode array
 */
export function toTreeNodes(entries: FileSystemEntry[]): FileTreeNode[] {
  return entries.map((entry) => ({
    ...entry,
    expanded: false,
    loading: false,
    children: entry.type === 'dir' ? [] : undefined
  }));
}

/**
 * Determines the Monaco Editor language from a file path
 * Uses shared utility from @deck-ide/shared
 */
export function getLanguageFromPath(filePath: string): string {
  return sharedGetLanguageFromPath(filePath);
}

/**
 * Adds a new node into the tree under the given parent path.
 * If parentPath is empty the node is inserted at root level.
 */
export function addTreeNode(
  nodes: FileTreeNode[],
  parentPath: string,
  newNode: FileTreeNode
): FileTreeNode[] {
  if (!parentPath) {
    const updated = [...nodes, newNode];
    return updated.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  return nodes.map((node) => {
    if (node.path === parentPath && node.type === 'dir') {
      const children = node.children || [];
      const updated = [...children, newNode].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { ...node, children: updated, expanded: true };
    }
    if (node.children) {
      return { ...node, children: addTreeNode(node.children, parentPath, newNode) };
    }
    return node;
  });
}

/**
 * Removes the node at targetPath from the tree (mutates children arrays).
 */
export function removeTreeNode(
  nodes: FileTreeNode[],
  targetPath: string
): FileTreeNode[] {
  return nodes.filter((node) => {
    if (node.path === targetPath) return false;
    if (node.children) {
      node.children = removeTreeNode(node.children, targetPath);
    }
    return true;
  });
}

/**
 * Updates a tree node by path, applying the updater function
 */
export function updateTreeNode(
  nodes: FileTreeNode[],
  targetPath: string,
  updater: (node: FileTreeNode) => FileTreeNode
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return updater(node);
    }
    if (node.children) {
      return {
        ...node,
        children: updateTreeNode(node.children, targetPath, updater)
      };
    }
    return node;
  });
}
