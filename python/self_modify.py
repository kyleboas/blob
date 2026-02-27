#!/usr/bin/env python3
"""
Self-Modification Engine - Advanced Python code generation for Blob
Handles complex refactoring, pattern recognition, and code analysis
"""

import ast
import json
import re
import sys
from typing import Dict, List, Optional, Any
from dataclasses import dataclass

@dataclass
class CodeChange:
    action: str  # 'add', 'modify', 'delete', 'refactor'
    target: str  # file or method name
    code: str
    explanation: str
    dependencies: List[str]


class TypeScriptAnalyzer:
    """Analyze TypeScript code to understand structure (simplified)"""
    
    def __init__(self, code: str):
        self.code = code
        self.methods = self._extract_methods()
        self.imports = self._extract_imports()
    
    def _extract_methods(self) -> List[Dict]:
        """Extract method signatures from TypeScript code"""
        methods = []
        # Simple regex-based extraction (not full parser)
        pattern = r'(?:private\s+|public\s+|async\s+)*(\w+)\s*\([^)]*\)\s*:\s*(\w+)\s*\{'
        for match in re.finditer(pattern, self.code):
            methods.append({
                "name": match.group(1),
                "return_type": match.group(2),
                "signature": match.group(0)
            })
        return methods
    
    def _extract_imports(self) -> List[str]:
        """Extract import statements"""
        imports = []
        pattern = r'import\s+.*?\s+from\s+[\'"]([^\'"]+)[\'"]'
        for match in re.finditer(pattern, self.code):
            imports.append(match.group(1))
        return imports
    
    def find_similar_methods(self, description: str) -> List[str]:
        """Find methods similar to description"""
        words = set(description.lower().split())
        matches = []
        for method in self.methods:
            method_words = set(method["name"].lower().replace('_', ' ').split())
            if words & method_words:
                matches.append(method["name"])
        return matches


class SelfModificationEngine:
    """Engine for generating self-modifications"""
    
    def __init__(self):
        self.generator = TypeScriptGenerator()
    
    def plan_modification(self, task: str, current_code: str) -> List[CodeChange]:
        """
        Create a plan for modifying the agent
        Returns a list of changes to apply
        """
        analyzer = TypeScriptAnalyzer(current_code)
        changes = []
        
        task_lower = task.lower()
        
        # Pattern: Add new capability
        if any(word in task_lower for word in ["add", "create", "new"]):
            change = self._plan_addition(task, analyzer)
            if change:
                changes.append(change)
        
        # Pattern: Fix issue
        elif any(word in task_lower for word in ["fix", "bug", "error", "broken"]):
            change = self._plan_fix(task, analyzer)
            if change:
                changes.append(change)
        
        # Pattern: Refactor
        elif any(word in task_lower for word in ["refactor", "clean", "improve"]):
            changes.extend(self._plan_refactor(task, analyzer))
        
        # Pattern: Optimize
        elif any(word in task_lower for word in ["optimize", "speed", "fast", "slow"]):
            change = self._plan_optimization(task, analyzer)
            if change:
                changes.append(change)
        
        return changes
    
    def _plan_addition(self, task: str, analyzer: TypeScriptAnalyzer) -> Optional[CodeChange]:
        """Plan adding new functionality"""
        # Check for similar existing methods
        similar = analyzer.find_similar_methods(task)
        
        if "tool" in task.lower():
            return CodeChange(
                action="add",
                target="tools",
                code=self._generate_tool_code(task),
                explanation=f"Add new tool for: {task}",
                dependencies=[]
            )
        else:
            return CodeChange(
                action="add",
                target="AgentDO",
                code=self._generate_method_code(task),
                explanation=f"Add new method for: {task}",
                dependencies=similar  # Reference similar methods
            )
    
    def _plan_fix(self, task: str, analyzer: TypeScriptAnalyzer) -> Optional[CodeChange]:
        """Plan a bug fix"""
        # Find likely target based on error description
        target = self._guess_target_from_task(task, analyzer)
        
        return CodeChange(
            action="modify",
            target=target,
            code=self._generate_fix_code(task),
            explanation=f"Fix for: {task}",
            dependencies=[]
        )
    
    def _plan_refactor(self, task: str, analyzer: TypeScriptAnalyzer) -> List[CodeChange]:
        """Plan refactoring changes"""
        changes = []
        
        # Extract method consolidation
        if "consolidate" in task.lower() or "merge" in task.lower():
            methods = analyzer.find_similar_methods(task)
            if len(methods) >= 2:
                changes.append(CodeChange(
                    action="refactor",
                    target="methods",
                    code=self._generate_consolidated_method(methods),
                    explanation=f"Consolidate methods: {', '.join(methods)}",
                    dependencies=methods
                ))
        
        return changes
    
    def _plan_optimization(self, task: str, analyzer: TypeScriptAnalyzer) -> Optional[CodeChange]:
        """Plan performance optimization"""
        return CodeChange(
            action="modify",
            target="performance",
            code=self._generate_optimized_code(task),
            explanation=f"Optimize: {task}",
            dependencies=[]
        )
    
    def _generate_tool_code(self, task: str) -> str:
        """Generate tool definition code"""
        tool_name = self._extract_name_from_task(task, "tool")
        return f'''{{
  name: "{tool_name}",
  description: "{task[:100]}",
  input_schema: {{
    type: "object",
    properties: {{
      input: {{ type: "string" }}
    }},
    required: ["input"]
  }}
}}'''
    
    def _generate_method_code(self, task: str) -> str:
        """Generate method implementation"""
        method_name = self._extract_name_from_task(task, "method")
        return f'''  private async {method_name}(input: string): Promise<string> {{
    // TODO: Implement based on: {task[:80]}
    console.log(`Executing {method_name}`);
    return input;
  }}'''
    
    def _generate_fix_code(self, task: str) -> str:
        """Generate fix code"""
        return '''// Add error handling
if (!input) {
  throw new Error("Invalid input provided");
}
// Original logic here...'''
    
    def _generate_consolidated_method(self, methods: List[str]) -> str:
        """Generate consolidated method from multiple methods"""
        return f'''  private async consolidatedHandler(action: string, input: string): Promise<void> {{
    switch (action) {{
      {''.join([f'case "{m}": return this.{m}(input);' for m in methods])}
      default: throw new Error(`Unknown action: ${{action}}`);
    }}
  }}'''
    
    def _generate_optimized_code(self, task: str) -> str:
        """Generate optimized code"""
        return '''// Cached result to avoid recomputation
const cacheKey = `${input}-${param}`;
if (this.cache.has(cacheKey)) {
  return this.cache.get(cacheKey);
}
const result = expensiveOperation(input, param);
this.cache.set(cacheKey, result);
return result;'''
    
    def _extract_name_from_task(self, task: str, default_type: str) -> str:
        """Extract a valid identifier name from task description"""
        # Look for quoted names
        match = re.search(r'["\'](\w+)["\']', task)
        if match:
            return match.group(1)
        
        # Generate from keywords
        words = re.findall(r'\b\w{4,}\b', task.lower())
        if words:
            return ''.join(w.capitalize() for w in words[:3])
        
        return f"new{default_type.capitalize()}"
    
    def _guess_target_from_task(self, task: str, analyzer: TypeScriptAnalyzer) -> str:
        """Guess which method/file needs fixing"""
        words = set(task.lower().split())
        for method in analyzer.methods:
            method_words = set(method["name"].lower().replace('_', ' ').split())
            if len(words & method_words) >= 2:
                return method["name"]
        return "AgentDO"


class TypeScriptGenerator:
    """Simple TypeScript code generator"""
    
    def generate_from_plan(self, plan: List[CodeChange]) -> Dict[str, Any]:
        """Generate final TypeScript code from plan"""
        result = {
            "files": {},
            "explanation": [],
            "warnings": []
        }
        
        for change in plan:
            result["explanation"].append(change.explanation)
            
            if change.action == "add":
                result["files"][change.target] = change.code
            elif change.action == "modify":
                result["files"][change.target] = f"// MODIFIED: {change.explanation}\n{change.code}"
            elif change.action == "refactor":
                result["files"][change.target] = f"// REFACTORED: {change.explanation}\n{change.code}"
                if change.dependencies:
                    result["warnings"].append(f"Remember to remove old methods: {change.dependencies}")
        
        return result


def main():
    """CLI entry point"""
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python self_modify.py '<task>' [current_code]"}))
        sys.exit(1)
    
    task = sys.argv[1]
    current_code = sys.argv[2] if len(sys.argv) > 2 else ""
    
    engine = SelfModificationEngine()
    plan = engine.plan_modification(task, current_code)
    
    generator = TypeScriptGenerator()
    result = generator.generate_from_plan(plan)
    
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
