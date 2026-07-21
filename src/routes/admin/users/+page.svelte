<script lang="ts">
    import { onMount } from 'svelte';
    import User from '@lucide/svelte/icons/user';
import Shield from '@lucide/svelte/icons/shield';
import Trash2 from '@lucide/svelte/icons/trash-2';
import Plus from '@lucide/svelte/icons/plus';
import Loader2 from '@lucide/svelte/icons/loader-2';
import Key from '@lucide/svelte/icons/key';
import Search from '@lucide/svelte/icons/search';
import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
import ChevronLeft from '@lucide/svelte/icons/chevron-left';
import ChevronRight from '@lucide/svelte/icons/chevron-right';

    let users: any[] = $state([]);
    let loading = $state(true);
    let isAddingUser = $state(false);
    let newUser = $state({ username: '', password: '', role: 'user' });
    let editingUser: any = $state(null);
    let editPassword = $state('');
    let searchQuery = $state('');

    onMount(async () => {
        await loadUsers();
    });

    async function loadUsers() {
        loading = true;
        try {
            const res = await fetch('/api/users');
            if (res.ok) {
                users = await res.json();
            }
        } catch (err) {
            console.error(err);
        } finally {
            loading = false;
        }
    }

    async function handleAddUser() {
        if (!newUser.username || !newUser.password) return;
        try {
            const res = await fetch('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newUser)
            });
            if (res.ok) {
                newUser = { username: '', password: '', role: 'user' };
                isAddingUser = false;
                await loadUsers();
            } else {
                const data = await res.json();
                alert(data.error || 'Failed to add user');
            }
        } catch (err) {
            console.error(err);
        }
    }

    async function handleUpdateUser(user: any) {
        const updates: any = { role: user.role };
        if (editPassword) {
            updates.password = editPassword;
        }
        try {
            const res = await fetch(`/api/users/${user.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });
            if (res.ok) {
                editingUser = null;
                editPassword = '';
                await loadUsers();
            }
        } catch (err) {
            console.error(err);
        }
    }

    async function handleDeleteUser(id: number) {
        if (!confirm('Are you sure you want to delete this user?')) return;
        try {
            const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
            if (res.ok) {
                await loadUsers();
            } else {
                const data = await res.json();
                alert(data.error || 'Failed to delete user');
            }
        } catch (err) {
            console.error(err);
        }
    }

    async function cycleRole(user: any) {
        let newRole = 'user';
        if (user.role === 'user') {
            newRole = 'contributor';
        } else if (user.role === 'contributor') {
            newRole = 'admin';
        } else if (user.role === 'admin') {
            newRole = 'user';
        }
        try {
            const res = await fetch(`/api/users/${user.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: newRole })
            });
            if (res.ok) {
                await loadUsers();
            }
        } catch (err) {
            console.error(err);
        }
    }

    let filteredUsers = $derived(
        users.filter(u => {
            const q = searchQuery.toLowerCase();
            return (
                u.username?.toLowerCase().includes(q) ||
                u.display_name?.toLowerCase().includes(q) ||
                u.email?.toLowerCase().includes(q)
            );
        })
    );
</script>

<div class="p-8">
    <header class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
            <h1 class="text-3xl font-bold text-[var(--text-primary)] mb-2">User Management</h1>
            <p class="text-[var(--text-muted)]">Manage system users and permissions.</p>
        </div>
        
        <button 
            onclick={() => isAddingUser = !isAddingUser}
            class="flex items-center justify-center gap-2 px-6 py-3 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 text-[#78FAAE] rounded-2xl font-bold transition-all shadow-lg shadow-[#0E3A2F]/20"
        >
            <Plus class="w-5 h-5" />
            <span>Add User</span>
        </button>
    </header>

    {#if isAddingUser}
        <div class="mb-8 p-8 bg-[var(--bg-slate-900)] border border-[var(--border-primary)] rounded-3xl shadow-xl animate-in fade-in slide-in-from-top-4 duration-300">
            <h2 class="text-xl font-bold mb-6 flex items-center gap-2">
                <Plus class="w-6 h-6 text-[#78FAAE]" />
                Create New User
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                    <label for="new-username" class="block text-sm font-medium text-[var(--text-muted)] mb-2">Username</label>
                    <input id="new-username" type="text" bind:value={newUser.username} class="w-full bg-[var(--bg-slate-950)] border border-[var(--border-primary)] rounded-2xl p-4 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-all" />
                </div>
                <div>
                    <label for="new-password" class="block text-sm font-medium text-[var(--text-muted)] mb-2">Password</label>
                    <input id="new-password" type="password" bind:value={newUser.password} class="w-full bg-[var(--bg-slate-950)] border border-[var(--border-primary)] rounded-2xl p-4 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-all" />
                </div>
                <div>
                    <label for="new-role" class="block text-sm font-medium text-[var(--text-muted)] mb-2">Role</label>
                    <select id="new-role" bind:value={newUser.role} class="w-full bg-[var(--bg-slate-950)] border border-[var(--border-primary)] rounded-2xl p-4 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-all">
                        <option value="user">User</option>
                        <option value="contributor">Contributor</option>
                        <option value="admin">Admin</option>
                    </select>
                </div>
            </div>
            <div class="mt-8 flex justify-end gap-4">
                <button onclick={() => isAddingUser = false} class="px-6 py-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">Cancel</button>
                <button onclick={handleAddUser} class="px-8 py-3 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 text-[#78FAAE] rounded-2xl font-bold transition-all">Create User</button>
            </div>
        </div>
    {/if}

    <div class="bg-[var(--bg-slate-900)] border border-[var(--border-primary)] rounded-3xl shadow-xl overflow-hidden">
        <div class="p-6 border-b border-[var(--border-primary)]">
            <div class="relative w-full md:w-96">
                <Search class="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-faint)]" />
                <input 
                    type="text" 
                    bind:value={searchQuery} 
                    placeholder="Search users..." 
                    class="w-full bg-[var(--bg-slate-950)] border border-[var(--border-primary)] rounded-2xl py-3 pl-12 pr-4 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-all"
                />
            </div>
        </div>

        <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
                <thead>
                    <tr class="bg-[var(--bg-slate-800-30)]">
                        <th class="p-6 text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">User</th>
                        <th class="p-6 text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">Email</th>
                        <th class="p-6 text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">Role</th>
                        <th class="p-6 text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">Provider</th>
                        <th class="p-6 text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">Created</th>
                        <th class="p-6 text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider text-right">Actions</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-[var(--border-primary)]">
                    {#if loading}
                        <tr>
                            <td colspan="6" class="p-12 text-center">
                                <Loader2 class="w-8 h-8 animate-spin mx-auto text-[var(--text-faint)]" />
                            </td>
                        </tr>
                    {:else if filteredUsers.length === 0}
                        <tr>
                            <td colspan="6" class="p-12 text-center text-[var(--text-faint)] italic">No users found.</td>
                        </tr>
                    {:else}
                        {#each filteredUsers as user}
                            <tr class="hover:bg-[var(--hover-surface)] transition-colors group">
                                <td class="p-6">
                                    <div class="flex items-center gap-3">
                                        <div class="w-10 h-10 rounded-xl bg-[var(--bg-slate-800)] flex items-center justify-center text-[var(--text-muted)]">
                                            <User class="w-5 h-5" />
                                        </div>
                                        <div class="flex flex-col">
                                            <span class="font-medium text-[var(--text-secondary)]">{user.display_name || user.username}</span>
                                            {#if user.display_name}
                                                <span class="text-xs text-[var(--text-faint)]">@{user.username}</span>
                                            {/if}
                                        </div>
                                    </div>
                                </td>
                                <td class="p-6">
                                    {#if user.email}
                                        <span class="text-sm text-[var(--text-muted)]">{user.email}</span>
                                    {:else}
                                        <span class="text-sm text-[var(--text-faint)] italic">—</span>
                                    {/if}
                                </td>
                                <td class="p-6">
                                    <button 
                                        onclick={() => cycleRole(user)}
                                        title="Click to cycle role (user -> contributor -> admin)"
                                        class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all hover:scale-105 active:scale-95 cursor-pointer
                                        {user.role === 'admin' ? 'bg-[#0E3A2F]/30 text-[#78FAAE] border border-[#0E3A2F]/50 hover:border-[#78FAAE]/80' : 
                                         user.role === 'contributor' ? 'bg-blue-950/40 text-blue-400 border border-blue-900/40 hover:border-blue-400/80' : 
                                         'bg-[var(--bg-slate-800)] text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-slate-700 hover:border-slate-500'}"
                                    >
                                        <Shield class="w-3.5 h-3.5" />
                                        {user.role}
                                    </button>
                                </td>
                                <td class="p-6">
                                    <span class="text-xs font-mono text-[var(--text-faint)] bg-[var(--bg-slate-950)] px-2 py-1 rounded-lg border border-[var(--border-primary)]">{user.provider}</span>
                                </td>
                                <td class="p-6">
                                    <span class="text-sm text-[var(--text-faint)]">{new Date(user.created_at).toLocaleDateString()}</span>
                                </td>
                                <td class="p-6 text-right">
                                    <div class="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button 
                                            onclick={() => editingUser = user}
                                            class="p-2 hover:bg-[var(--hover-surface)] rounded-xl text-[var(--text-faint)] hover:text-[var(--text-primary)] transition-all"
                                            title="Change Password"
                                        >
                                            <Key class="w-5 h-5" />
                                        </button>
                                        <button 
                                            onclick={() => handleDeleteUser(user.id)}
                                            class="p-2 hover:bg-red-900/30 rounded-xl text-[var(--text-faint)] hover:text-red-400 transition-all"
                                            title="Delete User"
                                        >
                                            <Trash2 class="w-5 h-5" />
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        {/each}
                    {/if}
                </tbody>
            </table>
        </div>
    </div>
</div>

{#if editingUser}
    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div class="w-full max-w-md bg-[var(--bg-slate-900)] border border-[var(--border-primary)] rounded-3xl shadow-2xl p-8 animate-in zoom-in-95 duration-200">
            <h2 class="text-2xl font-bold mb-2 flex items-center gap-3">
                <Key class="w-6 h-6 text-[#78FAAE]" />
                Change Password
            </h2>
            <p class="text-[var(--text-muted)] mb-8">Updating password for <span class="text-[var(--text-primary)] font-bold">{editingUser.username}</span></p>
            
            <div class="space-y-6">
                <div>
                    <label for="edit-password" class="block text-sm font-medium text-[var(--text-muted)] mb-2">New Password</label>
                    <input id="edit-password" type="password" bind:value={editPassword} class="w-full bg-[var(--bg-slate-950)] border border-[var(--border-primary)] rounded-2xl p-4 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-all" placeholder="••••••••" />
                </div>
            </div>

            <div class="mt-10 flex justify-end gap-4">
                <button onclick={() => { editingUser = null; editPassword = ''; }} class="px-6 py-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">Cancel</button>
                <button onclick={() => handleUpdateUser(editingUser)} class="px-8 py-3 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 text-[#78FAAE] rounded-2xl font-bold transition-all shadow-lg shadow-[#0E3A2F]/20">Update Password</button>
            </div>
        </div>
    </div>
{/if}
