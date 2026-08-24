import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { authApi } from "@/api/serverApi";

export const useAuthStore = defineStore("auth", () => {
  const user = ref(null);
  const token = ref(localStorage.getItem("auth_token") || null);
  const isLoading = ref(false);

  const isAuthenticated = computed(() => !!token.value && !!user.value);
  const userInfo = computed(() => user.value);

  const login = async (credentials) => {
    try {
      isLoading.value = true;
      const data = await authApi.login(credentials.username, credentials.password);
      token.value = data.token;
      user.value = { id: data.userId, username: data.username };
      authApi.saveAuth(data);
      return { success: true };
    } catch (error) {
      const msg = error.response?.data?.error || "登录失败";
      return { success: false, message: msg };
    } finally {
      isLoading.value = false;
    }
  };

  const register = async (userInfo) => {
    try {
      isLoading.value = true;
      const data = await authApi.register(userInfo.username, userInfo.password);
      return { success: true, message: "注册申请已提交", request: data };
    } catch (error) {
      const msg = error.response?.data?.error || "注册失败";
      return { success: false, message: msg };
    } finally {
      isLoading.value = false;
    }
  };

  const logout = () => {
    user.value = null;
    token.value = null;
    localStorage.removeItem("auth_token");
    localStorage.removeItem("auth_user");
  };

  const initAuth = async () => {
    const savedUser = authApi.getUser();
    if (token.value && savedUser) {
      user.value = savedUser;
    } else if (token.value && !savedUser) {
      logout();
    }
  };

  const fetchUserInfo = async () => {
    if (!token.value) return false;
    const savedUser = authApi.getUser();
    if (savedUser) {
      user.value = savedUser;
      return true;
    }
    logout();
    return false;
  };

  return {
    user,
    token,
    isLoading,
    isAuthenticated,
    userInfo,
    login,
    register,
    logout,
    fetchUserInfo,
    initAuth,
  };
});
