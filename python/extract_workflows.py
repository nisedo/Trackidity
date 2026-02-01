#!/usr/bin/env python3

import argparse
import contextlib
import json
import os
import sys
import traceback
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set, Tuple


@dataclass(frozen=True)
class Location:
    file: str
    line: int
    character: int = 0


def _location_from_source_mapping(obj: Any, workspace_root: str) -> Optional[Location]:
    try:
        src = getattr(obj, "source_mapping", None)
        if src is None:
            return None
        filename_absolute = getattr(src.filename, "absolute", None)
        filename_relative = getattr(src.filename, "relative", None)

        filename = None
        if isinstance(filename_absolute, str) and filename_absolute:
            root = workspace_root
            if root and not os.path.isdir(root):
                root = os.path.dirname(root)
            try:
                if (
                    root
                    and os.path.isabs(filename_absolute)
                    and os.path.commonpath([root, filename_absolute]) == root
                ):
                    rel = os.path.relpath(filename_absolute, root)
                    if not rel.startswith(".."):
                        filename = rel
            except Exception:
                filename = None

        if not filename and isinstance(filename_relative, str) and filename_relative:
            filename = filename_relative
        if not filename and isinstance(filename_absolute, str) and filename_absolute:
            filename = filename_absolute
        if not filename:
            return None
        lines = getattr(src, "lines", None) or []
        if not lines:
            return Location(file=filename, line=0, character=0)
        line0 = max(0, int(lines[0]) - 1)
        return Location(file=filename, line=line0, character=0)
    except Exception:
        return None


# Directories to exclude from entry point listing
_EXCLUDED_DIRS = {"lib", "dependencies", "test", "tests", "script", "scripts", "node_modules", "mock", "mocks"}


def _is_dependency(obj: Any) -> bool:
    try:
        src = getattr(obj, "source_mapping", None)
        if bool(getattr(src, "is_dependency", False)):
            return True
        # Also check if file path contains excluded directories
        filename = getattr(src.filename, "relative", None) or getattr(src.filename, "absolute", None)
        if isinstance(filename, str) and filename:
            parts = filename.replace("\\", "/").split("/")
            if any(part in _EXCLUDED_DIRS for part in parts):
                return True
        return False
    except Exception:
        return False


def _as_label_for_function(func: Any) -> str:
    # Use just the function name without parameters for cleaner display
    name = getattr(func, "name", None)
    if isinstance(name, str) and name:
        return name
    full = getattr(func, "full_name", None)
    if isinstance(full, str) and full:
        # Strip parameters if present
        return full.split("(")[0]
    return "<unknown>"


def _contract_name(func: Any) -> Optional[str]:
    try:
        contract = getattr(func, "contract_declarer", None)
        if contract is None:
            return None
        name = getattr(contract, "name", None)
        return name if isinstance(name, str) and name else None
    except Exception:
        return None


def _collect_overriding_functions(func: Any) -> List[Any]:
    try:
        base = getattr(func, "canonical_name", None)
        if not isinstance(base, str) or not base:
            return []

        seen: Set[str] = set([base])
        out: List[Any] = []
        queue: List[Any] = list(getattr(func, "overridden_by", []) or [])

        while queue:
            f = queue.pop(0)
            canonical = getattr(f, "canonical_name", None)
            if not isinstance(canonical, str) or not canonical:
                continue
            if canonical in seen:
                continue
            seen.add(canonical)
            out.append(f)
            queue.extend(list(getattr(f, "overridden_by", []) or []))

        return out
    except Exception:
        return []


def _resolve_to_implementation(func: Any, exclude_dependencies: bool) -> Any:
    """
    If `func` is declared in an interface/abstract contract (or lacks an implementation),
    attempt to resolve it to a concrete override that has an implementation.
    """
    try:
        canonical = getattr(func, "canonical_name", None)
        if not isinstance(canonical, str) or not canonical:
            return func

        decl = getattr(func, "contract_declarer", None)
        declared_in_iface = bool(getattr(decl, "is_interface", False))
        declared_in_abstract = bool(getattr(decl, "is_abstract", False))
        is_implemented = bool(getattr(func, "is_implemented", True))

        if is_implemented and not declared_in_iface and not declared_in_abstract:
            return func

        # Collect potential implementations
        impls: List[Any] = []

        # Method 1: Use overridden_by relationship
        overrides = _collect_overriding_functions(func)
        impls.extend([f for f in overrides if bool(getattr(f, "is_implemented", False))])

        # Method 2: For interface functions, search for implementations in contracts that inherit the interface
        if declared_in_iface and decl is not None:
            func_name = getattr(func, "name", None)
            func_full_name = getattr(func, "full_name", None)
            # Get contracts that inherit this interface
            derived = getattr(decl, "derived_contracts", []) or []
            for derived_contract in derived:
                if getattr(derived_contract, "is_interface", False):
                    continue
                # Look for a function with the same name/signature in the derived contract
                for f in getattr(derived_contract, "functions", []) or []:
                    if not bool(getattr(f, "is_implemented", False)):
                        continue
                    f_name = getattr(f, "name", None)
                    f_full_name = getattr(f, "full_name", None)
                    if f_full_name == func_full_name or (f_name == func_name and f_full_name is None):
                        if f not in impls:
                            impls.append(f)

        if not impls:
            return func

        if exclude_dependencies:
            non_dep = [f for f in impls if not _is_dependency(f)]
            if non_dep:
                impls = non_dep

        def score(f: Any) -> Tuple[int, str]:
            c = getattr(f, "contract_declarer", None)
            s = 0
            if c is not None:
                if not getattr(c, "is_interface", False):
                    s += 10
                if not getattr(c, "is_abstract", False):
                    s += 5
                if getattr(c, "is_fully_implemented", False):
                    s += 2
            if not _is_dependency(f):
                s += 3
            # Deterministic tie-breaker
            return (s, getattr(f, "canonical_name", "") or "")

        impls.sort(key=score, reverse=True)
        return impls[0]
    except Exception:
        return func


# Solidity built-in statements/functions to filter out (not meaningful function calls)
_SOLIDITY_BUILTINS = {
    # Statements
    "require", "assert", "revert", "return",
    # ABI encoding/decoding
    "abi.encode", "abi.encodePacked", "abi.encodeWithSelector",
    "abi.encodeWithSignature", "abi.encodeCall", "abi.decode",
    # Hashing
    "keccak256", "sha256", "ripemd160",
    # Byte/string concatenation
    "bytes.concat", "string.concat",
    # Cryptography
    "ecrecover",
    # Math
    "addmod", "mulmod",
    # Block
    "blockhash",
    # Transient storage (EIP-1153)
    "tload", "tstore",
    # Memory/calldata/storage operations
    "mload", "mstore", "calldataload", "sload", "sstore",
    # Bit manipulation
    "signextend",
    # Other
    "gasleft", "type",
}


def _collect_called_targets(func: Any) -> List[Tuple[str, Any, Optional[Any]]]:
    """
    Return list of (kindLabel, target, callsite_obj) where target is either:
      - Function-like object (has canonical_name/full_name/source_mapping)
      - SolidityFunction-like (has name)
      - Variable-like (has name)
      - None (unknown)

    callsite_obj is an object with a source_mapping (typically a CFG node), used to
    navigate to the callsite when there is no implementation location.
    """
    targets: List[Tuple[str, Any, Optional[Any]]] = []
    seen_base_ctors: Set[str] = set()  # Track base constructors to avoid duplicates

    # Modifiers (and base constructor calls modeled as modifiers).
    # These execute before the function body, so we surface them first.
    for mod in getattr(func, "modifiers", []) or []:
        if mod is None:
            continue
        # For constructors, Slither can model base constructor calls as Contract modifiers.
        base_ctor = getattr(mod, "constructors_declared", None)
        if base_ctor is not None:
            ctor_id = getattr(base_ctor, "canonical_name", None) or str(id(base_ctor))
            if ctor_id not in seen_base_ctors:
                seen_base_ctors.add(ctor_id)
                targets.append(("BaseConstructor", base_ctor, None))
            continue
        targets.append(("Modifier", mod, None))

    # Explicit base constructor calls (only relevant for constructors)
    for base_ctor in getattr(func, "explicit_base_constructor_calls", []) or []:
        if base_ctor is None:
            continue
        ctor_id = getattr(base_ctor, "canonical_name", None) or str(id(base_ctor))
        if ctor_id not in seen_base_ctors:
            seen_base_ctors.add(ctor_id)
            targets.append(("BaseConstructor", base_ctor, None))

    # Calls inside the function body, in source order (best effort).
    try:
        nodes = list(getattr(func, "nodes", []) or [])

        def _node_key(n: Any) -> Tuple[int, int]:
            try:
                src = getattr(n, "source_mapping", None)
                start = getattr(src, "start", None)
                if start is not None:
                    return (int(start), int(getattr(n, "node_id", 0)))
                lines = getattr(src, "lines", None) or []
                if lines:
                    return (int(lines[0]), int(getattr(n, "node_id", 0)))
            except Exception:
                pass
            return (10**18, int(getattr(n, "node_id", 0)))

        nodes.sort(key=_node_key)

        for node in nodes:
            for ir in getattr(node, "irs", []) or []:
                ir_type = ir.__class__.__name__
                target = getattr(ir, "function", None)
                if target is None:
                    continue

                # Skip modifier-call IR; we add modifiers explicitly above.
                if getattr(ir, "is_modifier_call", False):
                    continue

                # Skip constructor calls that were already added as BaseConstructor
                target_canonical = getattr(target, "canonical_name", None) or str(id(target))
                if target_canonical in seen_base_ctors:
                    continue
                # Also add this constructor to seen set to avoid duplicates from different IR representations
                if getattr(target, "is_constructor", False):
                    seen_base_ctors.add(target_canonical)

                # Ignore custom-error reverts (e.g. `revert MyError();`) as they are not function calls.
                target_name = getattr(target, "name", None)
                if isinstance(target_name, str) and target_name.startswith("revert "):
                    continue

                # Skip Solidity built-in statements/functions (require, abi.encode, keccak256, etc.)
                if isinstance(target_name, str):
                    # Handle both "require" and "require(bool,string)" formats
                    base_name = target_name.split("(")[0]
                    if base_name in _SOLIDITY_BUILTINS:
                        continue

                if ir_type == "LibraryCall":
                    kind_label = "Library"
                elif ir_type == "HighLevelCall":
                    kind_label = "External"
                elif ir_type == "SolidityCall" or target.__class__.__name__.startswith("Solidity"):
                    kind_label = "Solidity"
                else:
                    kind_label = "Internal"

                targets.append((kind_label, target, node))
    except Exception:
        # Fallback: keep whatever we already collected (modifiers/constructors).
        pass

    return targets


def _serialize_call_tree(
    func: Any,
    workspace_root: str,
    max_depth: int,
    exclude_dependencies: bool,
    expand_dependencies: bool,
    depth: int = 0,
    ancestors: Optional[Set[str]] = None,
) -> List[Dict[str, Any]]:
    if depth >= max_depth:
        return []

    if ancestors is None:
        ancestors = set()

    children: List[Dict[str, Any]] = []

    raw_targets = _collect_called_targets(func)

    for kind_label, target, callsite_obj in raw_targets:
        if target is None:
            continue

        target = _resolve_to_implementation(target, exclude_dependencies)

        label = None
        contract = None
        location = None
        callsite_location = None
        if callsite_obj is not None:
            callsite_loc = _location_from_source_mapping(callsite_obj, workspace_root)
            callsite_location = callsite_loc.__dict__ if callsite_loc else None

        canonical = getattr(target, "canonical_name", None)
        if isinstance(canonical, str) and canonical:
            node_id = canonical
            label = _as_label_for_function(target)
            contract = _contract_name(target)
            location_obj = _location_from_source_mapping(target, workspace_root)
            location = location_obj.__dict__ if location_obj else None
        else:
            # Solidity function / variable / unknown
            name = getattr(target, "name", None)
            if isinstance(name, str) and name:
                node_id = f"{kind_label}:{name}"
                label = name
            else:
                node_id = f"{kind_label}:<unknown>"
                label = "<unknown>"

        if location is None and callsite_location is not None:
            location = callsite_location

        cycle = node_id in ancestors
        tooltip_parts = []
        tooltip_parts.append(canonical if isinstance(canonical, str) and canonical else label)
        tooltip = " • ".join([p for p in tooltip_parts if p])

        node: Dict[str, Any] = {
            "label": label,
            "contract": contract,
            "kindLabel": kind_label,
            "tooltip": tooltip,
            "location": location,
            "cycle": cycle,
            "calls": [],
        }

        if (
            not cycle
            and isinstance(canonical, str)
            and canonical
            and (expand_dependencies or not (exclude_dependencies and _is_dependency(target)))
        ):
            next_ancestors = set(ancestors)
            next_ancestors.add(node_id)
            node["calls"] = _serialize_call_tree(
                target,
                workspace_root=workspace_root,
                max_depth=max_depth,
                exclude_dependencies=exclude_dependencies,
                expand_dependencies=expand_dependencies,
                depth=depth + 1,
                ancestors=next_ancestors,
            )

        children.append(node)

    return children


def _is_entry_point(func: Any) -> bool:
    """Check if a function is a public/external entry point (including view/pure)."""
    try:
        if not getattr(func, "is_implemented", False):
            return False
        if bool(getattr(func, "is_constructor_variables", False)):
            return False
        visibility = getattr(func, "visibility", None)
        if (
            bool(getattr(func, "is_constructor", False))
            or bool(getattr(func, "is_fallback", False))
            or bool(getattr(func, "is_receive", False))
        ):
            return True
        return visibility in ("public", "external")
    except Exception:
        return False


def _find_calling_entry_points(target_func: Any, contract: Any, visited: Optional[Set[str]] = None) -> Set[Any]:
    """Find all entry points that can reach target_func through call chains."""
    if visited is None:
        visited = set()

    target_canonical = getattr(target_func, "canonical_name", None) or str(id(target_func))
    if target_canonical in visited:
        return set()
    visited.add(target_canonical)

    entry_points: Set[Any] = set()

    # If this function is an entry point itself, add it
    if _is_entry_point(target_func):
        entry_points.add(target_func)

    # Find functions that call this one
    try:
        # Check all functions in the contract and its inheritance chain
        all_funcs: List[Any] = list(getattr(contract, "functions", []) or [])

        for caller in all_funcs:
            # Check if caller calls target_func (via internal_calls)
            internal_calls = getattr(caller, "internal_calls", []) or []
            if target_func in internal_calls:
                # Recursively find entry points that call this caller
                entry_points.update(_find_calling_entry_points(caller, contract, visited))

            # Also check modifiers_statements and other call patterns
            calls_as_expr = getattr(caller, "calls_as_expressions", []) or []
            for call_expr in calls_as_expr:
                called = getattr(call_expr, "called", None)
                if called is target_func:
                    entry_points.update(_find_calling_entry_points(caller, contract, visited))
    except Exception:
        pass

    return entry_points


def _extract_variables(
    slither_obj: Any,
    workspace_root: str,
    exclude_dependencies: bool,
) -> List[Dict[str, Any]]:
    """Extract state variables and their writing entry points."""
    from slither.core.declarations import FunctionContract  # type: ignore

    variables_by_file: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}  # file -> contract -> vars

    for cu in getattr(slither_obj, "compilation_units", []) or []:
        for contract in getattr(cu, "contracts", []) or []:
            if exclude_dependencies and _is_dependency(contract):
                continue
            if getattr(contract, "is_interface", False):
                continue
            # Skip abstract contracts - their variables will appear in concrete child contracts
            if getattr(contract, "is_abstract", False):
                continue

            contract_name = getattr(contract, "name", "") or "<unknown>"
            contract_loc = _location_from_source_mapping(contract, workspace_root)
            if contract_loc is None:
                continue
            file_rel = contract_loc.file

            # Gather ALL state variables that can be written by this contract's functions
            # This includes inherited variables that contract.state_variables misses
            all_writable_vars: Dict[str, Any] = {}  # canonical_name -> var object

            # First, get variables from contract.state_variables (direct + some inherited)
            for state_var in getattr(contract, "state_variables", []) or []:
                if getattr(state_var, "is_constant", False) or getattr(state_var, "is_immutable", False):
                    continue
                canonical = getattr(state_var, "canonical_name", None)
                if canonical:
                    all_writable_vars[canonical] = state_var

            # Then, add variables from contract.all_state_variables_written (includes inherited)
            try:
                for state_var in getattr(contract, "all_state_variables_written", []) or []:
                    if getattr(state_var, "is_constant", False) or getattr(state_var, "is_immutable", False):
                        continue
                    canonical = getattr(state_var, "canonical_name", None)
                    if canonical and canonical not in all_writable_vars:
                        all_writable_vars[canonical] = state_var
            except Exception:
                pass

            for var_canonical, state_var in all_writable_vars.items():
                var_name = getattr(state_var, "name", "") or "<unknown>"
                var_type = str(getattr(state_var, "type", "")) or "unknown"
                var_loc = _location_from_source_mapping(state_var, workspace_root)

                # Check if variable is inherited (declared in a different contract)
                var_declaring_contract = getattr(state_var, "contract", None)
                var_declaring_name = getattr(var_declaring_contract, "name", "") if var_declaring_contract else ""
                is_inherited = var_declaring_name and var_declaring_name != contract_name
                inherited_from = var_declaring_name if is_inherited else None

                # Find all functions that write to this variable (including transitively)
                writing_entry_points: Set[Any] = set()

                for func in getattr(contract, "functions", []) or []:
                    if not isinstance(func, FunctionContract):
                        continue

                    # Check if this function writes to the variable (directly or transitively)
                    # all_state_variables_written includes variables written through internal calls
                    try:
                        all_written = func.all_state_variables_written()
                    except Exception:
                        all_written = getattr(func, "state_variables_written", []) or []

                    # Compare by canonical name since object identity fails for inherited variables
                    written_canonicals = {getattr(v, "canonical_name", None) for v in all_written}
                    if var_canonical in written_canonicals:
                        if _is_entry_point(func):
                            writing_entry_points.add(func)
                        else:
                            # Trace back to find entry points that call this function
                            callers = _find_calling_entry_points(func, contract)
                            writing_entry_points.update(callers)

                # Skip variables with no writing entry points
                if not writing_entry_points:
                    continue

                # Build modifiers list (entry points that modify this variable)
                modifiers: List[Dict[str, Any]] = []
                for ep in writing_entry_points:
                    ep_canonical = getattr(ep, "canonical_name", "") or ""
                    ep_label = _as_label_for_function(ep)
                    ep_contract = _contract_name(ep) or contract_name
                    ep_loc = _location_from_source_mapping(ep, workspace_root)

                    modifiers.append({
                        "flowId": f"{file_rel}::{ep_canonical}",
                        "label": ep_label,
                        "contract": ep_contract,
                        "location": ep_loc.__dict__ if ep_loc else None,
                    })

                # Sort modifiers by label for consistent output
                modifiers.sort(key=lambda m: (m.get("contract", ""), m.get("label", "")))

                var_obj = {
                    "varId": f"{file_rel}::{contract_name}.{var_name}",
                    "name": var_name,
                    "type": var_type,
                    "contract": contract_name,
                    "inherited": is_inherited,
                    "inheritedFrom": inherited_from,
                    "isConstant": bool(getattr(state_var, "is_constant", False)),
                    "isImmutable": bool(getattr(state_var, "is_immutable", False)),
                    "location": var_loc.__dict__ if var_loc else None,
                    "modifiers": modifiers,
                }

                # Group by file -> contract
                if file_rel not in variables_by_file:
                    variables_by_file[file_rel] = {}
                if contract_name not in variables_by_file[file_rel]:
                    variables_by_file[file_rel][contract_name] = []
                variables_by_file[file_rel][contract_name].append(var_obj)

    # Convert to output format
    out_variables: List[Dict[str, Any]] = []
    for file_path in sorted(variables_by_file.keys()):
        contracts_data = variables_by_file[file_path]
        for contract_name in sorted(contracts_data.keys()):
            vars_list = contracts_data[contract_name]
            # Sort variables by line number (inherited vars without location go to end)
            vars_list.sort(key=lambda v: (
                0 if v.get("location") else 1,
                (v.get("location") or {}).get("line", 0),
                v.get("name", "")
            ))
            out_variables.append({
                "path": file_path,
                "contract": contract_name,
                "vars": vars_list,
            })

    return out_variables


def _is_state_changing_entrypoint(func: Any) -> bool:
    try:
        if not getattr(func, "is_implemented", False):
            return False
        # Never show Slither's synthetic constructor-variable init functions as entrypoints
        if bool(getattr(func, "is_constructor_variables", False)):
            return False
        visibility = getattr(func, "visibility", None)
        if bool(getattr(func, "view", False)) or bool(getattr(func, "pure", False)):
            return False

        # Always include special entrypoints
        if (
            bool(getattr(func, "is_constructor", False))
            or bool(getattr(func, "is_fallback", False))
            or bool(getattr(func, "is_receive", False))
        ):
            return True

        if visibility not in ("public", "external"):
            return False
        return True
    except Exception:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract Solidity workflows (entrypoints + call trees) using Slither.")
    parser.add_argument("--target", required=True, help="Workspace folder or target path to analyze.")
    parser.add_argument(
        "--workspace-root",
        default="",
        help="Workspace root used to relativize file paths in the output (defaults to --target).",
    )
    parser.add_argument(
        "--slither-repo",
        default="",
        help="Path to the Slither repo (folder containing the slither/ python package).",
    )
    parser.add_argument("--solc", default="", help="Optional solc binary path.")
    parser.add_argument("--solc-args", default="", help="Optional solc args string.")
    parser.add_argument("--filter-path", action="append", default=[], help="Optional filter path (repeatable).")
    parser.add_argument(
        "--exclude-dependencies",
        default="true",
        help="true/false: whether to hide functions in dependencies from output.",
    )
    parser.add_argument(
        "--expand-dependencies",
        default="false",
        help="true/false: whether to expand call graphs into dependency-defined functions.",
    )
    parser.add_argument("--max-depth", type=int, default=10, help="Max call depth.")

    args = parser.parse_args()

    exclude_dependencies = str(args.exclude_dependencies).lower() in ("1", "true", "yes", "y", "on")
    expand_dependencies = str(args.expand_dependencies).lower() in ("1", "true", "yes", "y", "on")
    workspace_root = args.workspace_root or args.target

    if args.slither_repo:
        sys.path.insert(0, args.slither_repo)

    try:
        from slither.slither import Slither  # type: ignore
        from slither.core.declarations import FunctionContract  # type: ignore
    except Exception as e:
        payload = {
            "version": 1,
            "ok": False,
            "error": (
                "Failed to import Slither. Ensure Slither is installed in the Python environment configured by "
                "trackidity.pythonPath, or set trackidity.slitherRepoPath to a Slither checkout. "
                f"Details: {e}"
            ),
        }
        print(json.dumps(payload))
        return 1

    try:
        slither_kwargs: Dict[str, Any] = {}
        if args.solc:
            slither_kwargs["solc"] = args.solc
        if args.solc_args:
            slither_kwargs["solc_args"] = args.solc_args
        if args.filter_path:
            slither_kwargs["filter_paths"] = args.filter_path

        # Slither can be noisy on stdout; keep stdout clean for JSON output.
        with contextlib.redirect_stdout(sys.stderr):
            sl = Slither(args.target, **slither_kwargs)

        # Collect all contracts
        all_contracts: List[Any] = []
        for cu in getattr(sl, "compilation_units", []) or []:
            all_contracts.extend(getattr(cu, "contracts", []) or [])

        # Separate abstract and concrete contracts
        abstract_contracts: Set[str] = set()
        concrete_contracts: List[Any] = []
        for c in all_contracts:
            if exclude_dependencies and _is_dependency(c):
                continue
            c_name = getattr(c, "name", "")
            if getattr(c, "is_abstract", False):
                abstract_contracts.add(c_name)
            elif not getattr(c, "is_interface", False):
                concrete_contracts.append(c)

        # Build map of concrete contract -> inherited functions from parent contracts
        # Each entry: (function, origin_contract_name)
        # Includes functions from:
        #   - Abstract parent contracts (their functions are not listed directly)
        #   - Dependency parent contracts (when exclude_dependencies=true, their functions are not listed directly)
        def get_inherited_functions(contract: Any) -> List[Tuple[Any, str]]:
            result: List[Tuple[Any, str]] = []
            seen_funcs: Set[str] = set()  # Track by full_name to deduplicate
            inheritance = getattr(contract, "inheritance", []) or []
            for parent in inheritance:
                parent_name = getattr(parent, "name", "")
                # Include inherited functions if parent is abstract or a dependency
                is_abstract_parent = parent_name in abstract_contracts
                is_dependency_parent = exclude_dependencies and _is_dependency(parent)
                if not is_abstract_parent and not is_dependency_parent:
                    continue
                for f in getattr(parent, "functions_declared", []) or []:
                    if not isinstance(f, FunctionContract):
                        continue
                    if not _is_state_changing_entrypoint(f):
                        continue
                    f_name = getattr(f, "full_name", "") or getattr(f, "name", "")
                    is_constructor = getattr(f, "is_constructor", False)
                    # Use contract-qualified name for dedup key to allow same-signature constructors from different parents
                    dedup_key = f"{parent_name}.{f_name}" if is_constructor else f_name
                    # Skip if already seen (dedup across inheritance chain)
                    if dedup_key in seen_funcs:
                        continue
                    # Check if this function is overridden in the concrete contract (skip for constructors)
                    is_overridden = False
                    if not is_constructor:
                        for own_f in getattr(contract, "functions_declared", []) or []:
                            own_f_name = getattr(own_f, "full_name", "") or getattr(own_f, "name", "")
                            if own_f_name == f_name:
                                is_overridden = True
                                break
                    if not is_overridden:
                        seen_funcs.add(dedup_key)
                        result.append((f, parent_name))
            return result

        all_functions: List[Any] = []
        for cu in getattr(sl, "compilation_units", []) or []:
            all_functions.extend(getattr(cu, "functions", []) or [])

        by_canonical: Dict[str, Any] = {}
        for f in all_functions:
            canonical = getattr(f, "canonical_name", None)
            if isinstance(canonical, str) and canonical and canonical not in by_canonical:
                by_canonical[canonical] = f

        # Collect entrypoints, excluding those from abstract contracts
        entrypoints: List[Tuple[Any, Optional[str], Optional[Any]]] = []  # (func, origin_contract, concrete_contract)
        for f in by_canonical.values():
            if not isinstance(f, FunctionContract):
                continue
            if exclude_dependencies and _is_dependency(f):
                continue
            if _is_state_changing_entrypoint(f):
                contract_name = _contract_name(f) or ""
                # Skip functions declared in abstract contracts
                if contract_name in abstract_contracts:
                    continue
                entrypoints.append((f, None, None))

        # Add inherited functions to concrete contracts
        for concrete in concrete_contracts:
            inherited = get_inherited_functions(concrete)
            for func, origin_name in inherited:
                entrypoints.append((func, origin_name, concrete))

        files: Dict[str, List[Dict[str, Any]]] = {}

        for f, origin_contract, concrete_contract in entrypoints:
            # For inherited functions, use concrete contract's location
            if concrete_contract is not None:
                concrete_loc = _location_from_source_mapping(concrete_contract, workspace_root)
                if concrete_loc is None:
                    continue
                file_rel = concrete_loc.file
                contract = getattr(concrete_contract, "name", "") or ""
            else:
                loc = _location_from_source_mapping(f, workspace_root)
                if loc is None:
                    continue
                file_rel = loc.file
                contract = _contract_name(f) or ""

            canonical = getattr(f, "canonical_name", "")
            base_label = _as_label_for_function(f)

            # Add origin indicator for inherited functions
            if origin_contract:
                label = base_label
                inherited_from = origin_contract
                # Create unique flow_id for inherited function in this concrete contract
                flow_id = f"{file_rel}::{contract}.{base_label}::from::{origin_contract}"
            else:
                label = base_label
                inherited_from = None
                flow_id = f"{file_rel}::{canonical}"

            tooltip = f"{canonical} • {file_rel}" if canonical else f"{label} • {file_rel}"

            # Use function's actual location for jumping
            func_loc = _location_from_source_mapping(f, workspace_root)

            ep_obj: Dict[str, Any] = {
                "flowId": flow_id,
                "label": label,
                "contract": contract,
                "tooltip": tooltip,
                "inherited": bool(origin_contract),
                "inheritedFrom": inherited_from,
                "location": func_loc.__dict__ if func_loc else {"file": file_rel, "line": 0, "character": 0},
                "calls": _serialize_call_tree(
                    f,
                    workspace_root=workspace_root,
                    max_depth=max(1, int(args.max_depth)),
                    exclude_dependencies=exclude_dependencies,
                    expand_dependencies=expand_dependencies,
                    depth=0,
                    ancestors=set([canonical]) if canonical else set([base_label]),
                ),
            }

            files.setdefault(file_rel, []).append(ep_obj)

        def _ep_key(e: Dict[str, Any]) -> Tuple[int, int, str]:
            # Sort by: (inherited, line, label)
            # inherited=False (0) comes before inherited=True (1)
            inherited = 1 if e.get("inherited", False) else 0
            try:
                loc = e.get("location") or {}
                line = int(loc.get("line", 10**9))
            except Exception:
                line = 10**9
            return (inherited, line, str(e.get("label", "")))

        out_files = []
        for file_path, eps in files.items():
            eps.sort(key=_ep_key)
            out_files.append({"path": file_path, "entrypoints": eps})
        out_files.sort(key=lambda f: f.get("path", ""))

        # Extract state variables and their writing entry points
        out_variables = _extract_variables(sl, workspace_root, exclude_dependencies)

        payload = {"version": 1, "ok": True, "files": out_files, "variables": out_variables}
        print(json.dumps(payload))
        return 0

    except Exception as e:
        payload = {
            "version": 1,
            "ok": False,
            "error": str(e),
            "traceback": traceback.format_exc(),
        }
        print(json.dumps(payload))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
