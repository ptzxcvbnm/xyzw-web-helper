<template>
  <div class="register-page">
    <div class="register-container" :class="{ 'admin-mode': isAdmin }">
      <div class="register-card glass">
        <div class="card-header">
          <div class="brand">
            <img src="/icons/xiaoyugan.png" alt="XYZW" class="brand-logo" />
            <h1 class="brand-title">申请注册</h1>
          </div>
          <p class="welcome-text">提交申请后，需要 admin 审核通过才能登录</p>
        </div>

        <div class="card-body">
          <n-alert v-if="submittedUsername" type="success" class="submit-result">
            用户 {{ submittedUsername }} 的申请已提交，请等待 admin 审核后再登录。
          </n-alert>

          <n-form
            ref="registerFormRef"
            :model="registerForm"
            :rules="registerRules"
            size="large"
            :show-label="false"
          >
            <n-form-item path="username">
              <n-input
                v-model:value="registerForm.username"
                placeholder="用户名"
                :input-props="{ autocomplete: 'username' }"
              >
                <template #prefix>
                  <n-icon>
                    <PersonCircle />
                  </n-icon>
                </template>
              </n-input>
            </n-form-item>

            <n-form-item path="password">
              <n-input
                v-model:value="registerForm.password"
                type="password"
                placeholder="密码"
                :input-props="{ autocomplete: 'new-password' }"
              >
                <template #prefix>
                  <n-icon>
                    <Lock />
                  </n-icon>
                </template>
              </n-input>
            </n-form-item>

            <n-form-item path="confirmPassword">
              <n-input
                v-model:value="registerForm.confirmPassword"
                type="password"
                placeholder="确认密码"
                :input-props="{ autocomplete: 'new-password' }"
                @keydown.enter="handleRegister"
              >
                <template #prefix>
                  <n-icon>
                    <Lock />
                  </n-icon>
                </template>
              </n-input>
            </n-form-item>

            <n-button
              type="primary"
              size="large"
              block
              :loading="authStore.isLoading"
              class="register-button"
              @click="handleRegister"
            >
              提交注册申请
            </n-button>
          </n-form>

          <div class="login-prompt">
            <n-button text type="primary" @click="router.push(isAdmin ? '/admin/dashboard' : '/login')">
              {{ isAdmin ? "返回控制台" : "返回登录" }}
            </n-button>
          </div>
        </div>
      </div>

      <div v-if="isAdmin" class="review-card glass">
        <div class="review-header">
          <div>
            <h2>待审核申请</h2>
            <p>批准后账号立即生效，申请人可使用原密码登录。</p>
          </div>
          <n-button :loading="requestsLoading" @click="loadRequests">刷新</n-button>
        </div>

        <n-spin :show="requestsLoading">
          <n-empty v-if="!requestsLoading && requests.length === 0" description="暂无待审核申请" />
          <div v-else class="request-list">
            <div v-for="request in requests" :key="request.id" class="request-item">
              <div class="request-info">
                <strong>{{ request.username }}</strong>
                <span>申请时间：{{ formatDate(request.createdAt) }}</span>
              </div>
              <div class="request-actions">
                <n-button
                  type="primary"
                  size="small"
                  :loading="processingId === request.id"
                  :disabled="!!processingId && processingId !== request.id"
                  @click="handleApprove(request)"
                >
                  通过
                </n-button>
                <n-button
                  type="error"
                  secondary
                  size="small"
                  :loading="processingId === request.id"
                  :disabled="!!processingId && processingId !== request.id"
                  @click="handleReject(request)"
                >
                  拒绝
                </n-button>
              </div>
            </div>
          </div>
        </n-spin>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { useDialog, useMessage } from "naive-ui";
import { useAuthStore } from "@/stores/auth";
import { authApi } from "@/api/serverApi";
import { PersonCircle } from "@vicons/ionicons5";

const router = useRouter();
const message = useMessage();
const dialog = useDialog();
const authStore = useAuthStore();
const registerFormRef = ref(null);
const submittedUsername = ref("");
const requests = ref([]);
const requestsLoading = ref(false);
const processingId = ref("");
const isAdmin = computed(() => authStore.userInfo?.username === "admin");

// 注册表单数据
const registerForm = reactive({
  username: "",
  password: "",
  confirmPassword: "",
});

// 表单验证规则
const registerRules = {
  username: [
    {
      required: true,
      message: "请输入用户名",
      trigger: ["input", "blur"],
    },
    {
      min: 2,
      max: 20,
      message: "用户名长度应在2-20个字符之间",
      trigger: ["input", "blur"],
    },
  ],
  password: [
    {
      required: true,
      message: "请输入密码",
      trigger: ["input", "blur"],
    },
    {
      min: 6,
      max: 128,
      message: "密码长度应在6-128位之间",
      trigger: ["input", "blur"],
    },
  ],
  confirmPassword: [
    {
      required: true,
      message: "请确认密码",
      trigger: ["input", "blur"],
    },
    {
      validator: (rule, value) => {
        return value === registerForm.password;
      },
      message: "两次输入的密码不一致",
      trigger: ["input", "blur"],
    },
  ],
};

// 处理注册
const handleRegister = async () => {
  if (!registerFormRef.value) return;

  try {
    await registerFormRef.value.validate();

    const result = await authStore.register({
      username: registerForm.username,
      password: registerForm.password,
    });

    if (result.success) {
      submittedUsername.value = result.request.username;
      message.success("注册申请已提交，等待 admin 审核");
      registerForm.username = "";
      registerForm.password = "";
      registerForm.confirmPassword = "";
      registerFormRef.value?.restoreValidation();
    } else {
      message.error(result.message);
    }
  } catch (error) {
    console.error("Registration validation failed:", error);
  }
};

const loadRequests = async () => {
  if (!isAdmin.value) return;
  requestsLoading.value = true;
  try {
    requests.value = await authApi.getRegistrationRequests();
  } catch (error) {
    message.error(error.response?.data?.error || "加载注册申请失败");
  } finally {
    requestsLoading.value = false;
  }
};

const handleApprove = async (request) => {
  processingId.value = request.id;
  try {
    await authApi.approveRegistrationRequest(request.id);
    requests.value = requests.value.filter((item) => item.id !== request.id);
    message.success(`已通过 ${request.username} 的注册申请`);
  } catch (error) {
    message.error(error.response?.data?.error || "审核失败");
    await loadRequests();
  } finally {
    processingId.value = "";
  }
};

const handleReject = (request) => {
  dialog.warning({
    title: "拒绝注册申请",
    content: `确定拒绝 ${request.username} 的注册申请吗？拒绝后对方可以重新提交。`,
    positiveText: "拒绝",
    negativeText: "取消",
    onPositiveClick: async () => {
      processingId.value = request.id;
      try {
        await authApi.rejectRegistrationRequest(request.id);
        requests.value = requests.value.filter((item) => item.id !== request.id);
        message.success(`已拒绝 ${request.username} 的注册申请`);
      } catch (error) {
        message.error(error.response?.data?.error || "拒绝申请失败");
        await loadRequests();
      } finally {
        processingId.value = "";
      }
    },
  });
};

const formatDate = (value) => new Date(value).toLocaleString("zh-CN", { hour12: false });

onMounted(async () => {
  await authStore.initAuth();
  await loadRequests();
});
</script>

<style scoped lang="scss">
.register-page {
  min-height: 100dvh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: var(--spacing-lg);
  padding-top: 8vh;
  padding-bottom: calc(var(--spacing-md) + env(safe-area-inset-bottom));
}

/* 深色主题下背景 */
[data-theme="dark"] .register-page {
  background: linear-gradient(135deg, #0f172a 0%, #1f2937 100%);
}

.register-container {
  max-width: 500px;
  width: 100%;
}

.register-container.admin-mode {
  max-width: 900px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 1fr);
  gap: var(--spacing-lg);
  align-items: start;
}

.register-card {
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  border-radius: var(--border-radius-xl);
  padding: var(--spacing-2xl);
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.3);
}

/* 深色主题下注册卡片 */
[data-theme="dark"] .register-card {
  background: rgba(17, 24, 39, 0.85);
  border-color: rgba(255, 255, 255, 0.1);
}

.review-card {
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  border-radius: var(--border-radius-xl);
  padding: var(--spacing-xl);
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.3);
}

[data-theme="dark"] .review-card {
  background: rgba(17, 24, 39, 0.85);
  border-color: rgba(255, 255, 255, 0.1);
}

.review-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-lg);

  h2 {
    margin: 0 0 var(--spacing-xs);
    color: var(--text-primary);
  }

  p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
}

.request-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.request-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  border: 1px solid var(--border-light);
  border-radius: var(--border-radius-medium);
}

.request-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);

  strong {
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }

  span {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
}

.request-actions {
  display: flex;
  gap: var(--spacing-sm);
  flex-shrink: 0;
}

.card-header {
  text-align: center;
  margin-bottom: var(--spacing-xl);
}

.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-lg);
}

.brand-logo {
  width: 64px;
  height: 64px;
  border-radius: var(--border-radius-large);
}

.brand-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
  margin: 0;
}

.welcome-text {
  color: var(--text-secondary);
  font-size: var(--font-size-md);
  margin: 0;
}

.card-body {
  .n-form {
    .n-form-item {
      margin-bottom: var(--spacing-lg);
    }
  }
}

.form-options {
  margin-bottom: var(--spacing-xl);

  :deep(.n-checkbox) {
    line-height: var(--line-height-relaxed);
  }
}

.register-button {
  height: 48px;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  margin-bottom: var(--spacing-lg);
}

.submit-result {
  margin-bottom: var(--spacing-lg);
}

.login-prompt {
  text-align: center;
  color: var(--text-secondary);

  span {
    margin-right: var(--spacing-sm);
  }
}

@media (max-width: 640px) {
  .register-card {
    padding: var(--spacing-xl);
  }

  .brand-title {
    font-size: var(--font-size-xl);
  }

  .request-item {
    align-items: stretch;
    flex-direction: column;
  }

  .request-actions .n-button {
    flex: 1;
  }
}

@media (max-width: 900px) {
  .register-container.admin-mode {
    grid-template-columns: 1fr;
    max-width: 500px;
  }
}
</style>
