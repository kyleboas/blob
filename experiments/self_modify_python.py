#!/usr/bin/env python3
"""
Prototype: Self-modifying Python agent
Demonstrates how Python enables easier runtime self-modification vs TypeScript
"""

import ast
import inspect
import sys
from pathlib import Path

class SelfModifyingAgent:
    def __init__(self):
        self.version = "0.1.0"
        self.modification_count = 0
        
    def read_own_source(self) -> str:
        """Read the current source code of this file"""
        return Path(__file__).read_text()
    
    def parse_own_ast(self) -> ast.AST:
        """Parse own source into AST for analysis"""
        source = self.read_own_source()
        return ast.parse(source)
    
    def add_capability(self, name: str, code: str) -> bool:
        """
        Add a new method to this class at runtime
        This is the key advantage over TypeScript
        """
        try:
            # Compile the new method
            compiled = compile(f"def {name}(self):\n    {code}", "<string>", "exec")
            
            # Execute in local namespace
            local_ns = {}
            exec(compiled, {"__name__": __name__}, local_ns)
            
            # Attach to class
            setattr(self.__class__, name, local_ns[name])
            
            self.modification_count += 1
            print(f"✓ Added capability: {name}")
            return True
            
        except Exception as e:
            print(f"✗ Failed to add {name}: {e}")
            return False
    
    def modify_existing(self, method_name: str, new_code: str) -> bool:
        """
        Modify an existing method
        In TypeScript this would require recompilation
        """
        try:
            compiled = compile(f"def {method_name}(self):\n    {new_code}", "<string>", "exec")
            local_ns = {}
            exec(compiled, {"__name__": __name__}, local_ns)
            setattr(self.__class__, method_name, local_ns[method_name])
            print(f"✓ Modified: {method_name}")
            return True
        except Exception as e:
            print(f"✗ Failed to modify {method_name}: {e}")
            return False
    
    def list_capabilities(self):
        """List all methods (capabilities) of this agent"""
        methods = [m for m in dir(self) if not m.startswith('_') and callable(getattr(self, m))]
        print(f"\nCapabilities ({len(methods)}):")
        for m in methods:
            print(f"  - {m}")
    
    def save_state(self):
        """Save current state to disk"""
        state = {
            "version": self.version,
            "modifications": self.modification_count,
            "capabilities": [m for m in dir(self) if not m.startswith('_') and callable(getattr(self, m))]
        }
        Path("agent_state.json").write_text(str(state))
        print(f"✓ State saved")


def demo():
    """Demonstrate self-modification capabilities"""
    print("=" * 60)
    print("Self-Modifying Python Agent Demo")
    print("=" * 60)
    
    agent = SelfModifyingAgent()
    
    # Show initial capabilities
    agent.list_capabilities()
    
    # Add new capability at runtime
    print("\n--- Adding new capability ---")
    agent.add_capability("greet", 'return f"Hello from {self.version}!"')
    
    # Use the new capability
    print(f"\n--- Testing new capability ---")
    result = agent.greet()
    print(f"Result: {result}")
    
    # Add another capability
    agent.add_capability("calculate", 'return sum(range(100))')
    print(f"Calculate: {agent.calculate()}")
    
    # Show updated capabilities
    agent.list_capabilities()
    
    # Save state
    agent.save_state()
    
    print("\n--- Comparison with TypeScript ---")
    print("TypeScript requires:")
    print("  1. Write new code")
    print("  2. Run tsc (compilation)")
    print("  3. Fix type errors (iterative)")
    print("  4. Deploy")
    print("")
    print("Python requires:")
    print("  1. exec() new code")
    print("  2. Done")
    print("")
    print(f"This agent has modified itself {agent.modification_count} times")
    print("with zero compilation steps.")


if __name__ == "__main__":
    demo()
