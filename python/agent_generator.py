#!/usr/bin/env python3
"""
Agent Code Generator - Python module for generating TypeScript code
Called from TypeScript agent via sandbox.exec()
"""

import json
import sys
import re
from typing import Dict, List, Optional, Tuple

class TypeScriptGenerator:
    """Generates TypeScript code for Blob agent modifications"""
    
    def __init__(self):
        self.indent = "  "
    
    def generate_method(self, name: str, params: List[Dict], body: str, return_type: str = "void") -> str:
        """Generate a TypeScript method"""
        param_str = ", ".join([f"{p['name']}: {p['type']}" for p in params])
        lines = [
            f"  private async {name}({param_str}): Promise<{return_type}> {{",
        ]
        for line in body.strip().split('\n'):
            lines.append(f"    {line}")
        lines.append("  }")
        return '\n'.join(lines)
    
    def generate_tool(self, name: str, description: str, schema: Dict) -> str:
        """Generate a tool definition for the agent"""
        return json.dumps({
            "name": name,
            "description": description,
            "input_schema": schema
        }, indent=2)
    
    def modify_agent(self, task: str, current_code: str) -> Dict:
        """
        Analyze task and generate TypeScript modifications
        Returns dict with: { action: 'add_method'|'modify_method'|'add_tool', code: str, explanation: str }
        """
        task_lower = task.lower()
        
        # Pattern matching for common modifications
        if "add tool" in task_lower or "new tool" in task_lower:
            return self._generate_tool_from_task(task)
        
        if "add method" in task_lower or "new method" in task_lower:
            return self._generate_method_from_task(task)
        
        if "fix" in task_lower or "bug" in task_lower:
            return self._generate_fix_from_task(task, current_code)
        
        # Default: generate a simple utility method
        return {
            "action": "add_method",
            "code": self._generate_utility_method(task),
            "explanation": f"Generated utility method for: {task}"
        }
    
    def _generate_tool_from_task(self, task: str) -> Dict:
        """Generate a new tool definition"""
        # Extract tool name from task
        match = re.search(r'(?:add|new)\s+tool\s+(?:called\s+)?["\']?(\w+)["\']?', task, re.I)
        name = match.group(1) if match else "new_tool"
        
        tool_code = f'''{{
  name: "{name}",
  description: "Tool generated for: {task[:50]}...",
  input_schema: {{
    type: "object",
    properties: {{
      param1: {{ type: "string", description: "First parameter" }}
    }},
    required: ["param1"]
  }}
}}'''
        
        return {
            "action": "add_tool",
            "code": tool_code,
            "explanation": f"Added new tool: {name}"
        }
    
    def _generate_method_from_task(self, task: str) -> Dict:
        """Generate a new method"""
        match = re.search(r'(?:add|new)\s+method\s+(?:called\s+)?["\']?(\w+)["\']?', task, re.I)
        name = match.group(1) if match else "newMethod"
        
        method_code = self.generate_method(
            name=name,
            params=[{"name": "input", "type": "string"}],
            body=f'''// TODO: Implement {name}
console.log(`Executing {name} with: ${{input}}`);
return input;''',
            return_type="string"
        )
        
        return {
            "action": "add_method",
            "code": method_code,
            "explanation": f"Added new method: {name}"
        }
    
    def _generate_fix_from_task(self, task: str, current_code: str) -> Dict:
        """Generate a fix for existing code"""
        # Simple pattern: wrap problematic code in try-catch
        return {
            "action": "modify_method",
            "code": "try {\n  // Original code here\n} catch (error) {\n  console.error('Error:', error);\n  throw error;\n}",
            "explanation": "Added error handling wrapper"
        }
    
    def _generate_utility_method(self, task: str) -> str:
        """Generate a simple utility method"""
        method_name = re.sub(r'[^\w]', '_', task.lower()[:20])
        
        return self.generate_method(
            name=f"handle_{method_name}",
            params=[],
            body=f'''// Generated for: {task[:60]}
this.forwardToGlobalLogs("generated_method", "Executing generated handler");
return Promise.resolve();''',
            return_type="void"
        )


def main():
    """CLI entry point for TypeScript agent to call"""
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No task provided"}))
        sys.exit(1)
    
    task = sys.argv[1]
    current_code = sys.argv[2] if len(sys.argv) > 2 else ""
    
    generator = TypeScriptGenerator()
    result = generator.modify_agent(task, current_code)
    
    # Output as JSON for TypeScript to parse
    print(json.dumps(result))


if __name__ == "__main__":
    main()
